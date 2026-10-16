/**
 * at0412-text-card-asset-strip.test.ts — a Text card shows what its document
 * has attached, in a strip derived from the document's own text.
 *
 * ## What this pins
 *
 * The strip is a **projection**, not a stored list: there is no record anywhere
 * of what a document has attached, only the `assets/`-scoped links the buffer
 * itself carries. That single decision is what makes hand-editing work with no
 * extra machinery, and it is what this test drives — by typing and deleting
 * link text rather than by using any attachment gesture at all.
 *
 * ## Shape
 *
 *   1. A temp directory holding `doc.md` and an `assets/` folder with a real
 *      PNG and a real non-image file. The document already links the PNG.
 *   2. The strip shows one tile, painted from the file's own path through
 *      `/api/fs/blob` — never from base64 the card would have to hold.
 *   3. A second link is typed by hand: a second tile appears, and it shows the
 *      file's real macOS QuickLook render — not an invisible slot where an
 *      image would be, and not a generic document glyph either.
 *   4. ⌘Z takes the link away and the tile with it; ⌘⇧Z brings both back. The
 *      strip follows the text because it *is* the text.
 *   5. A link to a file that is not there renders a tile anyway, marked
 *      missing — a typo is visible rather than silent.
 *
 * The second half drives the gestures that put files there in the first place:
 * a drop on a buffer that has never been saved (which used to be refused
 * outright, with a modal), the Save As that migrates its assets into the
 * destination directory, and ⌘V with image data.
 *
 * @covers tugdeck/src/lib/asset-projection.ts
 * @covers tugdeck/src/lib/os-thumbnail-store.ts
 * @covers tugdeck/src/lib/asset-links.ts
 * @covers tugdeck/src/lib/attachment-upload.ts
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-text-card-editor/file-drop.ts
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.css
 * @covers tugdeck/src/components/tugways/cards/tug-attachment-preview.tsx
 * @covers tugdeck/src/components/tugways/cards/tug-attachment-preview.css
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

/** A real PNG already in the tree — real bytes a real decoder has to handle. */
const REPO_PNG_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "resources",
  "AppIcon-1024b.png",
);

const EDITOR_HOST_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"]';
const EDITOR_CONTENT_SELECTOR = `${EDITOR_HOST_SELECTOR} .cm-content`;
const STRIP_SELECTOR = '[data-testid="text-card-asset-strip"]';
const TILE_SELECTOR = `${STRIP_SELECTOR} [data-slot="tug-attachment-preview__tile"]`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "text", title: "doc.md", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** What each strip tile is captioned with, in strip order. */
function tileCaptions(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(
      `${STRIP_SELECTOR} [data-slot="tug-attachment-preview__caption"]`,
    )})).map(function(el){ return el.textContent || ""; })`,
  );
}

/** A condition that holds once the strip shows exactly `n` tiles. */
function tileCountIs(n: number): string {
  return `document.querySelectorAll(${JSON.stringify(TILE_SELECTOR)}).length === ${n}`;
}

/** The editor's whole document, read off CM6's rendered lines. */
function docText(app: App): Promise<string> {
  return app.evalJS<string>(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${EDITOR_CONTENT_SELECTOR} .cm-line`)}))
      .map(function(l){ return l.textContent || ""; })
      .join("\\n")`,
  );
}

/**
 * Build a small PNG in-page and hand it to `deliver`, which dispatches
 * whichever event the caller is testing. `evalJS` cannot await, so the handler
 * signals through a window flag the test polls.
 */
function withGeneratedPng(fileName: string, deliver: string): string {
  return `(function(){
    window.__at0412Done = false;
    var canvas = document.createElement("canvas");
    canvas.width = 80; canvas.height = 48;
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#2b3a55"; ctx.fillRect(0, 0, 80, 48);
    ctx.fillStyle = "#e8c07d"; ctx.fillRect(10, 10, 28, 28);
    canvas.toBlob(function(blob){
      blob.arrayBuffer().then(function(buf){
        var bytes = new Uint8Array(buf);
        var host = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
        var file = new File([bytes], ${JSON.stringify(fileName)}, { type: "image/png" });
        var dt = new DataTransfer();
        dt.items.add(file);
        ${deliver}
        window.__at0412Done = true;
      });
    }, "image/png");
  })()`;
}

/** Drop a real PNG `File` on the editor under `fileName`. */
async function dropPngOnEditor(app: App, fileName: string): Promise<void> {
  await app.evalJS<void>(
    withGeneratedPng(
      fileName,
      `var r = host.getBoundingClientRect();
       var ev = new DragEvent("drop", {
         bubbles: true,
         cancelable: true,
         clientX: r.left + 4,
         clientY: r.bottom - 6,
       });
       Object.defineProperty(ev, "dataTransfer", { value: dt });
       host.dispatchEvent(ev);`,
    ),
  );
  await app.waitForCondition<boolean>(`window.__at0412Done === true`, {
    timeoutMs: 10_000,
  });
}

/**
 * Paste image data on the editor — the screenshot gesture.
 *
 * A synthesized `paste` event carrying an `image/png` file in
 * `clipboardData.items`, which is the only channel image bytes arrive
 * through: the native clipboard bridge's read result carries no image data.
 */
async function pasteImageOnEditor(app: App): Promise<void> {
  await app.evalJS<void>(
    withGeneratedPng(
      "image.png",
      `var ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
       Object.defineProperty(ev, "clipboardData", { value: dt });
       host.dispatchEvent(ev);`,
    ),
  );
  await app.waitForCondition<boolean>(`window.__at0412Done === true`, {
    timeoutMs: 10_000,
  });
}

/**
 * Put the caret at the end of the document and type `text` for real.
 *
 * `nativeType` posts printable characters only, so newlines are pressed as
 * Return — which is what a person does anyway.
 */
async function typeAtEnd(app: App, lines: readonly string[]): Promise<void> {
  await app.click(EDITOR_CONTENT_SELECTOR);
  // ⌘↓ — document end, so the typed link lands on its own after the seed.
  await app.nativeKey("ArrowDown", ["cmd"]);
  for (const line of lines) {
    await app.nativeKey("Return");
    if (line.length > 0) await app.nativeType(line);
  }
}

describe.skipIf(!SHOULD_RUN)(
  "at0412: the Text card's attachment strip is derived from the document",
  () => {
    test(
      "tiles follow the document's asset links through typing, deletion, and undo",
      async () => {
        const dir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), "at0412-")),
        );
        const docPath = path.join(dir, "doc.md");
        const assetsDir = path.join(dir, "assets");
        fs.mkdirSync(assetsDir);
        fs.copyFileSync(REPO_PNG_FIXTURE, path.join(assetsDir, "shown.png"));
        fs.writeFileSync(
          path.join(assetsDir, "notes.txt"),
          "Real text, so QuickLook has a real page to draw.\n",
          "utf8",
        );
        fs.writeFileSync(
          docPath,
          "# Notes\n\nSEEDED ![shown](assets/shown.png)\n",
          "utf8",
        );

        try {
          const app = await launchTugApp({ testName: "at0412-asset-strip" });
          try {
            await app.seedDeckState({
              state: deckShape(),
              cardStates: {
                A: {
                  content: {
                    path: docPath,
                    anchor: { line: 1, ch: 0 },
                    scrollTop: 0,
                  },
                },
              },
              focusCardId: "A",
            });
            await app.waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
                return el !== null && el.innerText.indexOf("SEEDED") !== -1;
              })()`,
              { timeoutMs: 15_000 },
            );

            // ── The seeded link projects a tile ────────────────────────────
            await app.waitForCondition<boolean>(tileCountIs(1), {
              timeoutMs: 15_000,
            });
            expect(await tileCaptions(app)).toEqual(["shown.png"]);

            // Painted from the file's own path. The strip stands for files
            // already on disk, so holding their bytes in JS to draw a
            // thumbnail would park a whole document's assets in memory.
            const imgSrc = await app.evalJS<string>(
              `(function(){
                var img = document.querySelector(${JSON.stringify(
                  `${STRIP_SELECTOR} img`,
                )});
                return img === null ? "" : img.getAttribute("src") || "";
              })()`,
            );
            expect(imgSrc).toContain("/api/fs/blob?path=");
            expect(decodeURIComponent(imgSrc)).toContain(
              path.join(assetsDir, "shown.png"),
            );

            // ── A link typed by hand lights a tile ─────────────────────────
            // No attachment gesture involved: the strip is a projection, so
            // the text IS the interface.
            await typeAtEnd(app, ["", "[notes](assets/notes.txt)"]);
            await app.waitForCondition<boolean>(tileCountIs(2), {
              timeoutMs: 15_000,
            });
            expect(await tileCaptions(app)).toEqual(["shown.png", "notes.txt"]);

            // A non-image attachment has no pixels of its own, but macOS can
            // draw it — so the tile shows the real QuickLook render (a page of
            // this file's text) rather than a generic document glyph. The
            // glyph is the fallback for a file QuickLook has nothing for, not
            // the resting state for every non-image.
            //
            // A `data:` src is unambiguous here: the image tile beside it
            // paints from `/api/fs/blob`, so only the thumbnail bridge can put
            // an inline PNG in this strip.
            await app.waitForCondition<boolean>(
              `Array.from(document.querySelectorAll(${JSON.stringify(
                `${STRIP_SELECTOR} img`,
              )})).some(function(i){
                return (i.getAttribute("src") || "").indexOf("data:image/png") === 0;
              })`,
              { timeoutMs: 15_000 },
            );

            // ── Undo takes the link away, and the tile with it ─────────────
            // The strip follows the text because it *is* the text — no
            // bookkeeping anywhere had to be told the attachment was gone.
            await app.nativeKey("z", ["cmd"]);
            await app.waitForCondition<boolean>(tileCountIs(1), {
              timeoutMs: 15_000,
            });
            expect(await tileCaptions(app)).toEqual(["shown.png"]);

            // ── And redo brings both back ──────────────────────────────────
            await app.nativeKey("z", ["cmd", "shift"]);
            await app.waitForCondition<boolean>(tileCountIs(2), {
              timeoutMs: 15_000,
            });
            expect(await tileCaptions(app)).toEqual(["shown.png", "notes.txt"]);
          } finally {
            await app.close();
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "an unsaved buffer accepts a drop with no precondition and no modal",
      async () => {
        try {
          // The draft id is minted per run: an untitled buffer's aside is
          // kept machine-wide (`~/Library/Application Support/Tug/Autosave
          // Information`), so a fixed id would restore the links a previous
          // run dropped, into an instance whose draft home never received
          // their files.
          const draftId = `A-${Date.now().toString(36)}`;
          const app = await launchTugApp({ testName: "at0412-untitled-drop" });
          try {
            await app.seedDeckState({
              state: deckShape(),
              cardStates: {
                A: {
                  // Never saved, and never will be until the Save As below —
                  // the case that used to raise a modal refusing the drop.
                  content: {
                    path: null,
                    draftId,
                    untitled: true,
                    untitledNumber: 1,
                    anchor: { line: 1, ch: 0 },
                    scrollTop: 0,
                  },
                },
              },
              focusCardId: "A",
            });
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)}) !== null`,
              { timeoutMs: 15_000 },
            );

            await dropPngOnEditor(app, "photo.png");

            // The drop landed: a link, and a tile painted from a real file in
            // the buffer's own draft home. No banner anywhere — the untitled
            // precondition is gone, not merely reworded.
            await app.waitForCondition<boolean>(tileCountIs(1), {
              timeoutMs: 20_000,
            });
            expect(
              await app.evalJS<number>(
                `document.querySelectorAll('[data-card-id="A"] [data-slot="tug-pane-banner"]').length`,
              ),
            ).toBe(0);
            expect(await docText(app)).toContain("![photo](assets/photo.png)");
            expect(await tileCaptions(app)).toEqual(["photo.png"]);

            // The link is the same relative form a saved document holds, which
            // is what lets Save As migrate the home without rewriting prose.
            const tileSrc = await app.evalJS<string>(
              `(function(){
                var img = document.querySelector(${JSON.stringify(
                  `${STRIP_SELECTOR} img`,
                )});
                return img === null ? "" : img.getAttribute("src") || "";
              })()`,
            );
            expect(decodeURIComponent(tileSrc)).toContain(
              `/draft-docs/${draftId}/assets/photo.png`,
            );
          } finally {
            await app.close();
          }
        } finally {
          // Nothing to clean: the draft home lives under the app-test
          // instance's own data dir, which the harness owns.
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "pasted image data lands as a timestamped asset with a link and a tile",
      async () => {
        const dir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), "at0412-paste-")),
        );
        const docPath = path.join(dir, "doc.md");
        fs.writeFileSync(docPath, "# Notes\n\nSEEDED\n", "utf8");

        try {
          const app = await launchTugApp({ testName: "at0412-image-paste" });
          try {
            await app.seedDeckState({
              state: deckShape(),
              cardStates: {
                A: {
                  content: {
                    path: docPath,
                    anchor: { line: 1, ch: 0 },
                    scrollTop: 0,
                  },
                },
              },
              focusCardId: "A",
            });
            await app.waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
                return el !== null && el.innerText.indexOf("SEEDED") !== -1;
              })()`,
              { timeoutMs: 15_000 },
            );

            await pasteImageOnEditor(app);
            await app.waitForCondition<boolean>(tileCountIs(1), {
              timeoutMs: 20_000,
            });

            // Named where the write happens, so the timestamp and the file are
            // one step. Nothing was silently dropped, which is what a paste on
            // this card used to do.
            const assets = fs.readdirSync(path.join(dir, "assets"));
            expect(assets).toHaveLength(1);
            expect(assets[0]).toMatch(/^pasted-\d{4}-\d{2}-\d{2}-\d{6}\.png$/);
            expect(await docText(app)).toContain(`(assets/${assets[0]})`);
          } finally {
            await app.close();
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "an attach that fails shows on the tile, with no banner and no inert body",
      async () => {
        const dir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), "at0412-failed-")),
        );
        const docPath = path.join(dir, "doc.md");
        fs.writeFileSync(docPath, "# Notes\n\nSEEDED\n", "utf8");
        // The document's own directory is read-only, so creating `assets/`
        // beside it fails — a real permission failure, not a simulated one.
        fs.chmodSync(dir, 0o500);

        try {
          const app = await launchTugApp({ testName: "at0412-attach-failure" });
          try {
            await app.seedDeckState({
              state: deckShape(),
              cardStates: {
                A: {
                  content: {
                    path: docPath,
                    anchor: { line: 1, ch: 0 },
                    scrollTop: 0,
                  },
                },
              },
              focusCardId: "A",
            });
            await app.waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
                return el !== null && el.innerText.indexOf("SEEDED") !== -1;
              })()`,
              { timeoutMs: 15_000 },
            );

            await dropPngOnEditor(app, "photo.png");

            // The failure names the file, on the thing that failed.
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(
                `${STRIP_SELECTOR} [data-slot="tug-attachment-preview__file"][data-failed]`,
              )}).length === 1`,
              { timeoutMs: 20_000 },
            );
            expect(await tileCaptions(app)).toEqual(["photo.png"]);

            // And no modal: no banner, and the pane body is not `inert` — the
            // defect where two banners fought over one `inert` flag cannot
            // happen when the card renders exactly one.
            expect(
              await app.evalJS<number>(
                `document.querySelectorAll('[data-card-id="A"] [data-slot="tug-pane-banner"]').length`,
              ),
            ).toBe(0);
            expect(
              await app.evalJS<boolean>(
                `(function(){
                  var body = document.querySelector('[data-card-id="A"] .tug-pane-body');
                  return body !== null && body.hasAttribute("inert");
                })()`,
              ),
            ).toBe(false);
            // Nothing was written to the document either — a link to a file
            // that does not exist would be worse than no link.
            expect(await docText(app)).not.toContain("assets/photo.png");
          } finally {
            await app.close();
          }
        } finally {
          fs.chmodSync(dir, 0o700);
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a link to a file that is not there renders a missing tile, not nothing",
      async () => {
        const dir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), "at0412-missing-")),
        );
        const docPath = path.join(dir, "doc.md");
        fs.writeFileSync(
          docPath,
          "# Notes\n\nSEEDED ![gone](assets/gone.png)\n",
          "utf8",
        );

        try {
          const app = await launchTugApp({ testName: "at0412-missing-tile" });
          try {
            await app.seedDeckState({
              state: deckShape(),
              cardStates: {
                A: {
                  content: {
                    path: docPath,
                    anchor: { line: 1, ch: 0 },
                    scrollTop: 0,
                  },
                },
              },
              focusCardId: "A",
            });
            await app.waitForCondition<boolean>(
              `(function(){
                var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT_SELECTOR)});
                return el !== null && el.innerText.indexOf("SEEDED") !== -1;
              })()`,
              { timeoutMs: 15_000 },
            );

            // The tile exists — a typo the user can see — and shows the broken
            // state rather than an image that will never load.
            await app.waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(
                `${STRIP_SELECTOR} [data-slot="tug-attachment-preview__broken"]`,
              )}).length === 1`,
              { timeoutMs: 20_000 },
            );
            expect(await tileCaptions(app)).toEqual(["gone.png"]);
          } finally {
            await app.close();
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/**
 * at0416-viewer-card-settings.test.ts — the viewer card's gear, and what its
 * settings actually do to a real image and a real PDF.
 *
 * ## What this gates
 *
 * The viewer used to be a card with one verb and no preferences: an image was
 * scaled one way, on one ground, and a PDF opened one way, and none of it was
 * the reader's to say. The gear in the pane's title bar is the door onto
 * those decisions, so what is worth proving is that the door opens and that
 * every choice behind it reaches the pixels:
 *
 *   1. **The gear is there, and only where there is something to set.** A
 *      viewer bound to an image publishes both title-bar buttons — reveal and
 *      the gear — and the gear's press opens the sheet for the kind the card
 *      is showing, not a generic one.
 *   2. **A choice changes the surface, live.** Scaling and background are
 *      read by the image block as it stands; nothing remounts and no file is
 *      re-fetched. The attributes the stylesheet branches on are what this
 *      asserts, because they are the state ([L06]) — a screenshot would prove
 *      the same thing more slowly and less legibly.
 *   3. **A setting persists as the CARD's, not the deck's.** The first change
 *      snapshots the card's own values into its own tugbank slot, which is
 *      the contract that makes "settings apply when the file is opened; once
 *      tuned, the card owns them" true.
 *   4. **The PDF preferences are preferences, not state.** The page gap
 *      re-lays the document out while it is open, and the sheet's controls
 *      never claim to be the live zoom the reader is holding.
 *
 * Both fixtures are encoded by this test rather than checked in, so the repo
 * carries no binary fixture — the rule at0311 set for the PDF, applied to the
 * PNG as well.
 *
 * @covers tugdeck/src/components/tugways/cards/file-view-card.tsx
 * @covers tugdeck/src/components/tugways/cards/file-view-card.css
 * @covers tugdeck/src/components/tugways/cards/card-settings-sheet.tsx
 * @covers tugdeck/src/components/tugways/cards/image-card-controls.tsx
 * @covers tugdeck/src/components/tugways/cards/pdf-card-controls.tsx
 * @covers tugdeck/src/components/tugways/cards/settings-viewer-card-body.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/image-block.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/image-block.css
 * @covers tugdeck/src/lib/image-card-settings.ts
 * @covers tugdeck/src/lib/pdf-card-settings.ts
 * @covers tugdeck/src/lib/use-card-settings.ts
 * @covers tugdeck/src/lib/use-image-card-settings.ts
 * @covers tugdeck/src/lib/use-pdf-card-settings.ts
 * @covers tugdeck/src/lib/default-card-settings-store.ts
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const NO_AX = { skipAccessibilityPreflight: true } as const;

const CARD = '[data-slot="file-view-card"]';
const FIGURE = `${CARD} [data-slot="image-body"]`;
const INFO = '[data-testid="file-view-card-info"]';
const PDF_SURFACE = '[data-slot="file-view-pdf"]';
const PDF_PAGE = `${PDF_SURFACE} [data-slot="pdf-page"]`;

const REVEAL_BUTTON = '[data-testid="tug-pane-title-bar-item-reveal-card-file"]';
const GEAR_BUTTON = '[data-testid="tug-pane-title-bar-item-show-card-settings"]';

const IMAGE_SHEET = '[data-testid="image-card-settings"]';
const PDF_SHEET = '[data-testid="pdf-card-settings"]';

/** The fixture's real dimensions, so the info strip can be checked against
 *  something the test knows independently of what the app reports. */
const IMAGE_WIDTH = 6;
const IMAGE_HEIGHT = 4;

/** CRC-32, the flavour PNG chunks carry. */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/**
 * A real RGBA PNG of known size — every pixel opaque red except one
 * transparent column, so the file genuinely has something for the
 * checkerboard ground to show through.
 */
function encodePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const px = row + 1 + x * 4;
      raw[px] = 220;
      raw[px + 1] = 40;
      raw[px + 2] = 40;
      raw[px + 3] = x === 0 ? 0 : 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A two-page PDF, byte-accurate xref and all — at0311's encoder, trimmed. */
function encodePdf(pageCount: number): Buffer {
  const objects: string[] = [];
  const fontId = 3 + pageCount * 2;
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(
    " ",
  );
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>\n`);
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>\n`);
  for (let i = 0; i < pageCount; i += 1) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontId} 0 R >> >> ` +
        `/Contents ${4 + i * 2} 0 R >>\n`,
    );
    const body = `BT /F1 36 Tf 72 700 Td (Page ${i + 1}) Tj ET\n`;
    objects.push(`<< /Length ${body.length} >>\nstream\n${body}endstream\n`);
  }
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}endobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** An attribute off the first matching element, or null. */
function attr(selector: string, name: string): string {
  return `(function () {
    var el = document.querySelector(${JSON.stringify(selector)});
    return el === null ? null : el.getAttribute(${JSON.stringify(name)});
  })()`;
}

/** Open the gear's sheet and wait for the named body to stand. */
async function openGear(app: App, sheet: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(GEAR_BUTTON)}) !== null`,
    { timeoutMs: 10_000 },
  );
  // The gear rests inside the pane's rollup, revealed on a title-bar hover.
  // Pin the row open first or the press lands on the bar behind it.
  await app.revealPaneControls();
  await app.nativeClickAtElement(GEAR_BUTTON);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(sheet)}) !== null`,
    { timeoutMs: 10_000 },
  );
}

/**
 * Click a choice-group segment by its label, inside the open sheet. The
 * segments carry no per-value selector, so the point is taken from the
 * segment a reader would aim at — the same approach at0311 takes to the PDF
 * context menu's rows.
 */
async function chooseSegment(
  app: App,
  groupTestId: string,
  label: string,
): Promise<void> {
  const point = JSON.parse(
    await app.evalJS<string>(
      `(function () {
         var group = document.querySelector(
           "[data-testid=" + JSON.stringify(${JSON.stringify(groupTestId)}) + "]",
         );
         if (group === null) return "null";
         var seg = Array.from(group.querySelectorAll('[role="radio"]')).find(
           function (el) { return (el.textContent || "").trim() === ${JSON.stringify(label)}; },
         );
         if (!seg) return "null";
         var box = seg.getBoundingClientRect();
         return JSON.stringify({
           x: Math.round(box.left + box.width / 2),
           y: Math.round(box.top + box.height / 2),
         });
       })()`,
    ),
  ) as { x: number; y: number } | null;
  if (point === null) throw new Error(`[at0416] segment ${label} not found`);
  await app.nativeClick(point);
}

describe.skipIf(!SHOULD_RUN)("at0416 — the viewer card's own settings", () => {
  test(
    "the gear opens an image's settings, and every choice reaches the picture",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0416-image-"));
      const file = path.join(dir, "swatch.png");
      fs.writeFileSync(file, encodePng(IMAGE_WIDTH, IMAGE_HEIGHT));

      const app = await launchTugApp({
        ...NO_AX,
        testName: "at0416-viewer-card-settings-image",
      });
      try {
        await app.dispatchControlAction("open-file", { path: file });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIGURE)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // Both verbs stand in the title bar, each as its own button.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(REVEAL_BUTTON)}).length`,
          ),
        ).toBe(1);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(GEAR_BUTTON)}).length`,
          ),
        ).toBe(1);

        // The resting state, before anyone has chosen anything: the built-in
        // defaults, which is what an untouched card resolves to.
        expect(await app.evalJS<string>(attr(FIGURE, "data-tugx-image-fit"))).toBe(
          "fit",
        );
        expect(
          await app.evalJS<string>(attr(FIGURE, "data-tugx-image-ground")),
        ).toBe("checker");
        expect(
          await app.evalJS<string>(attr(FIGURE, "data-tugx-image-smoothing")),
        ).toBe("on");
        // The info strip is off by default, so nothing says the file's size.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(INFO)}).length`,
          ),
        ).toBe(0);

        await openGear(app, IMAGE_SHEET);

        // ---- Scaling: the choice reaches both the block and the card frame.
        await chooseSegment(app, "image-option-scaling", "Actual Size");
        await app.waitForCondition<boolean>(
          `${attr(FIGURE, "data-tugx-image-fit")} === "actual"`,
          { timeoutMs: 10_000 },
        );
        // The card frame answers for scrolling at actual size, so it carries
        // the choice too — a settings write that reached only the block would
        // leave an oversized image uncentered and unscrollable.
        expect(
          await app.evalJS<string>(attr(CARD, "data-file-view-image-fit")),
        ).toBe("actual");

        // ---- Background: what shows through the transparent column.
        await chooseSegment(app, "image-option-background", "Black");
        await app.waitForCondition<boolean>(
          `${attr(FIGURE, "data-tugx-image-ground")} === "black"`,
          { timeoutMs: 10_000 },
        );

        // ---- Smoothing off: nearest-neighbour, which is the whole point of
        // opening a 6-pixel-wide swatch in a card hundreds of pixels wide.
        await app.nativeClickAtElement(
          `${IMAGE_SHEET} [data-testid="image-option-smoothing"]`,
        );
        await app.waitForCondition<boolean>(
          `${attr(FIGURE, "data-tugx-image-smoothing")} === "off"`,
          { timeoutMs: 10_000 },
        );
        expect(
          await app.evalJS<string>(
            `(function () {
               var img = document.querySelector(${JSON.stringify(`${FIGURE} img`)});
               return img === null ? "" : getComputedStyle(img).imageRendering;
             })()`,
          ),
        ).toBe("pixelated");

        // ---- The info strip: the file's own facts, and the dimensions this
        // test encoded rather than whatever the card felt like reporting.
        await app.nativeClickAtElement(
          `${IMAGE_SHEET} [data-testid="image-option-show-info"]`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(INFO)}) !== null`,
          { timeoutMs: 10_000 },
        );
        const info = await app.evalJS<string>(
          `document.querySelector(${JSON.stringify(INFO)}).innerText`,
        );
        expect(info).toContain(`${IMAGE_WIDTH} × ${IMAGE_HEIGHT}`);
        expect(info).toContain("PNG image");
        // The byte count comes from a HEAD against the same blob route the
        // `<img>` is pointed at, so it is the real file's size on disk.
        const bytes = fs.statSync(file).size;
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(INFO)}).innerText.indexOf(${JSON.stringify(
            `${bytes} bytes`,
          )}) !== -1`,
          { timeoutMs: 10_000 },
        );

        // ---- The card owns them now: the first change snapshotted the full
        // set into this card's own tugbank slot, which is what makes a tuned
        // card stop following the deck defaults.
        const cardId = await app.evalJS<string>(
          `window.tugdeck.diag.getDeckState().cards.find(
             (c) => c.componentId === "file-view",
           ).id`,
        );
        const persisted = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify(window.__tug.getTugbankValue("dev.image-card", ${JSON.stringify(
              cardId,
            )}))`,
          ),
        ) as { kind: string; value: Record<string, unknown> } | null;
        expect(persisted?.value).toEqual({
          scaling: "actual",
          background: "black",
          smoothing: false,
          showInfo: true,
        });
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the Settings card's Viewer Cards section edits the deck-wide defaults",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0416-defaults-"));
      const file = path.join(dir, "swatch.png");
      fs.writeFileSync(file, encodePng(IMAGE_WIDTH, IMAGE_HEIGHT));

      const app = await launchTugApp({
        ...NO_AX,
        testName: "at0416-viewer-card-defaults",
      });
      try {
        // A card standing with nothing of its own — the state in which the
        // deck defaults are what it is following.
        await app.dispatchControlAction("open-file", { path: file });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIGURE)}) !== null`,
          { timeoutMs: 20_000 },
        );

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("show-card", { component: "settings" }), null)`,
        );
        await app.click('[data-testid="tug-tab-view-tab-viewerCard"]');
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="settings-viewer-card"]') !== null`,
          { timeoutMs: 10_000 },
        );

        // Both kinds are in the one section — the viewer is one card, and a
        // reader should not have to learn that images and PDFs keep their
        // preferences in different rooms.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('[data-testid="image-card-controls"]').length`,
          ),
        ).toBe(1);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll('[data-testid="pdf-card-controls"]').length`,
          ),
        ).toBe(1);

        // A default changed here reaches the open card that never pinned
        // anything — which is the whole difference between a default and a
        // setting, and the reason the card resolves live rather than at mount.
        await chooseSegment(app, "image-option-background", "White");
        await app.waitForCondition<boolean>(
          `${attr(FIGURE, "data-tugx-image-ground")} === "white"`,
          { timeoutMs: 10_000 },
        );
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a PDF's gear sets preferences, and the page gap re-lays the document out",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0416-pdf-"));
      const file = path.join(dir, "two-pages.pdf");
      fs.writeFileSync(file, encodePdf(2));

      const app = await launchTugApp({
        ...NO_AX,
        testName: "at0416-viewer-card-settings-pdf",
      });
      try {
        await app.dispatchControlAction("open-file", { path: file });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(PDF_PAGE)}).length > 1`,
          { timeoutMs: 30_000 },
        );

        /** The gap between the first two laid-out pages, as rendered. */
        const gapBetweenPages = (): Promise<number> =>
          app.evalJS<number>(
            `(function () {
               var pages = Array.from(
                 document.querySelectorAll(${JSON.stringify(PDF_PAGE)}),
               ).map(function (el) { return el.getBoundingClientRect(); });
               return Math.round(pages[1].top - pages[0].bottom);
             })()`,
          );

        // The surface's own spacing, which is what the built-in preference
        // says — a fresh document must not shift because this shipped.
        expect(await gapBetweenPages()).toBe(12);

        // The gear opens the PDF sheet, not the image one: one command, and
        // the card decides which room it opens onto.
        await openGear(app, PDF_SHEET);
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(IMAGE_SHEET)}).length`,
          ),
        ).toBe(0);

        // ---- The page gap re-lays out the document that is already open.
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.pdf-card", window.tugdeck.diag
             .getDeckState().cards.find((c) => c.componentId === "file-view").id,
             { kind: "json", value: { pageMode: "continuous", openingZoom: "fit-width",
               pageGap: 40, invertInDark: true } }), null)`,
        );
        await app.waitForCondition<boolean>(
          `(function () {
             var pages = Array.from(
               document.querySelectorAll(${JSON.stringify(PDF_PAGE)}),
             ).map(function (el) { return el.getBoundingClientRect(); });
             return pages.length > 1 && Math.round(pages[1].top - pages[0].bottom) === 40;
           })()`,
          { timeoutMs: 10_000 },
        );

        // ---- Invert is the preference; whether it PAINTS is the theme's
        // answer, which is why the surface carries the preference as an
        // attribute and the stylesheet reads the theme beside it.
        expect(
          await app.evalJS<string>(attr(PDF_SURFACE, "data-pdf-invert-in-dark")),
        ).toBe("on");
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

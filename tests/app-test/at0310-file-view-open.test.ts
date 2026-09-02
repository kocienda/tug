/**
 * at0310-file-view-open.test.ts — opening a file Tug views rather than edits:
 * the viewer card mounts, fetches real bytes, reuses by path, and lists in the
 * Cards card's Files group. A second case covers the PDF branch of the same card,
 * which the deck renders itself with pdf.js.
 *
 * ## What this gates
 *
 * The whole M01 chain, end to end, on a real file:
 *
 *   1. `open-file` with an image path routes to a `file-view` card rather than
 *      a Text card — the kind branch in `openFileInCard`.
 *   2. The card's `<img>` actually decodes, which means tugcast's
 *      `/api/fs/blob` served the bytes with a `Content-Type` WebKit accepted.
 *      `naturalWidth > 0` is the assertion that cannot be faked by a mounted
 *      element: it is true only after a successful fetch AND decode.
 *   3. A second open of the same path fronts the same card instead of
 *      mounting a second copy of the same bytes.
 *   4. The Cards card's **Files** group lists the viewer beside text cards, without
 *      the unsaved dot (a viewer is read-only and can never be dirty), and its
 *      close box closes the card.
 *   5. The pane wears the **document masthead** the card publishes: name,
 *      path, and a kind label composed from the classifier plus the extension
 *      — and, for a PDF, the page count that only the surface knows. The tier
 *      is 72px before that count arrives, which is the whole of [P11].
 *
 * Both the PNG and the two-page PDF are encoded by this test rather than
 * checked in, so the bytes the route serves are produced here and the repo
 * carries no binary fixture.
 *
 * @covers tugdeck/src/lib/open-file-in-card.ts
 * @covers tugdeck/src/lib/file-kinds.ts
 * @covers tugdeck/src/lib/file-view-open-registry.ts
 * @covers tugdeck/src/components/tugways/cards/file-view-card.tsx
 * @covers tugdeck/src/components/tugways/cards/pdf-view.tsx
 * @covers tugdeck/src/lib/card-title-store.ts
 * @covers tugdeck/src/components/tugways/tug-path.tsx
 * @covers tugdeck/src/components/tugways/tug-path.css
 * @covers tugdeck/src/lib/pdf-runtime.ts
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/cards/cards-data-source.ts
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deflateSync } from "node:zlib";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const NO_AX = { skipAccessibilityPreflight: true } as const;

const CARD_IMG = '[data-slot="file-view-card"] img.tugx-image-img';
const CARD_PDF = '[data-slot="file-view-pdf"]';
const CARD_PAGE = '[data-slot="file-view-pdf"] [data-slot="pdf-page"]';
const CARD_CANVAS = `${CARD_PAGE} canvas`;
const ROW_TITLE = ".cards-list .cards-row-headline .tug-list-row-title";
const ROW_CLOSE = ".cards-list .cards-row-close";
const ROW_GLYPH = ".cards-list .cards-row-glyph";
const UNSAVED_DOT = '[data-testid="cards-card-unsaved"]';

const IMAGE_WIDTH = 48;
const IMAGE_HEIGHT = 32;

/**
 * A masthead line on the pane hosting the viewer card.
 *
 * Pane-scoped by construction rather than by id: the card is opened by
 * `open-file`, so its pane is whichever one the deck minted. The masthead
 * lives in the PANE's title bar, which is not a descendant of the card
 * element — a selector prefixed with the card would match nothing.
 */
async function mastheadLine(app: App, testid: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(() => {
       const card = document.querySelector('[data-slot="file-view-card"]');
       const pane = card === null ? null : card.closest(".tug-pane");
       const el = pane === null
         ? null
         : pane.querySelector('[data-testid=${JSON.stringify(testid)}]');
       return el === null ? null : el.innerText;
     })()`,
  );
}

/** The title bar's tier, less the 1px divider that sits below it. */
async function paneTier(app: App): Promise<number> {
  return app.evalJS<number>(
    `(() => {
       const card = document.querySelector('[data-slot="file-view-card"]');
       const bar = card.closest(".tug-pane").querySelector(".tug-pane-title-bar");
       const border = parseFloat(getComputedStyle(bar).borderBottomWidth) || 0;
       return bar.getBoundingClientRect().height - border;
     })()`,
  );
}

/** Expression: count of deck cards with the given componentId. */
function countByComponent(componentId: string): string {
  return `window.tugdeck.diag.getDeckState().cards.filter(
    (c) => c.componentId === ${JSON.stringify(componentId)},
  ).length`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, payload, CRC over type+payload. */
function chunk(type: string, payload: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, Buffer.from(payload)]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(payload.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/**
 * Encode a real 8-bit RGBA PNG with a two-axis gradient. Every byte is
 * produced here — signature, IHDR, zlib-deflated scanlines, IEND — so what
 * `/api/fs/blob` streams and WebKit decodes is a genuine image, not a
 * placeholder the decoder might accept by accident.
 */
function encodePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter type: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = Math.round((x / (width - 1)) * 255);
      raw[offset + 1] = Math.round((y / (height - 1)) * 255);
      raw[offset + 2] = 0x40;
      raw[offset + 3] = 0xff;
      offset += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/**
 * Encode a real two-page PDF with visible text on each page — objects, stream
 * lengths, a byte-accurate xref table, and the trailer. Generated here for the
 * same reason as the PNG: the viewer must be judged on a document a real
 * reader would accept, without a binary fixture in the repo.
 */
function encodePdf(): Buffer {
  const page = (contents: number): string =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 7 0 R >> >> /Contents ${contents} 0 R >>\n`;
  const stream = (text: string): string => {
    const body = `BT /F1 36 Tf 72 700 Td (${text}) Tj ET\n`;
    return `<< /Length ${body.length} >>\nstream\n${body}endstream\n`;
  };
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>\n`,
    `<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>\n`,
    page(4),
    stream("Page One"),
    page(6),
    stream("Page Two"),
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n`,
  ];

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

describe.skipIf(!SHOULD_RUN)("at0310 — image opens in a viewer card", () => {
  test(
    "open-file mounts a file-view card, reuses by path, and lists in the Cards card",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0310-"));
      const file = path.join(dir, "gradient.png");
      fs.writeFileSync(file, encodePng(IMAGE_WIDTH, IMAGE_HEIGHT));

      const app = await launchTugApp({
        ...NO_AX,
        testName: "at0310-file-view-open",
      });
      try {
        // ---- The image routes to a viewer card, not a Text card.
        await app.dispatchControlAction("open-file", { path: file });
        await app.waitForCondition<boolean>(
          `${countByComponent("file-view")} === 1`,
          { timeoutMs: 15_000 },
        );
        expect(await app.evalJS<number>(countByComponent("text"))).toBe(0);

        // ---- The bytes reach WebKit through the real /api/fs/blob route.
        // naturalWidth is non-zero only after a successful fetch AND decode.
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${CARD_IMG}');
            return el !== null && el.naturalWidth > 0;
          })()`,
          { timeoutMs: 15_000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelector('${CARD_IMG}').naturalWidth`,
          ),
        ).toBe(IMAGE_WIDTH);
        expect(
          await app.evalJS<number>(
            `document.querySelector('${CARD_IMG}').naturalHeight`,
          ),
        ).toBe(IMAGE_HEIGHT);

        // ---- A viewer is a DOCUMENT card, so its pane wears the masthead.
        //
        // Three lines from three different sources: the basename the card
        // already displayed, the full path it is bound to, and a kind label
        // composed from the classifier's coarse answer plus the extension —
        // "image" is not what a reader calls a PNG.
        expect(await paneTier(app)).toBeCloseTo(72, 0);
        expect(await mastheadLine(app, "card-masthead-title")).toBe("gradient.png");
        expect(await mastheadLine(app, "card-masthead-description")).toContain(
          "gradient.png",
        );
        expect(await mastheadLine(app, "card-masthead-detail")).toBe("PNG image");

        // ---- …and the path truncates in the MIDDLE.
        //
        // A path's two informative ends are its root and its filename, and
        // end truncation destroys the second: the reader is left with a
        // directory chain they already knew. The head run absorbs the
        // shrinking, so the claim is that the head is clipped while the tail
        // — the filename — measures out whole. Both runs are real text
        // whatever the box does, so the assertion is on layout and not on
        // the string.
        // Whether the fixture's temp dir happens to overflow this pane is not
        // something to leave to chance, so the squeeze is applied: the line is
        // measured at its natural width, then again capped narrow — the same
        // constraint a narrower pane imposes, since the cap is on the run's
        // own box — and restored.
        const truncation = await app.evalJS<{
          head: string;
          tail: string;
          natural: { headClipped: boolean; tailWhole: boolean; withinLine: boolean };
          squeezed: { headClipped: boolean; tailWhole: boolean; withinLine: boolean };
        }>(`(() => {
           const card = document.querySelector('[data-slot="file-view-card"]');
           const pane = card.closest(".tug-pane");
           const path = pane.querySelector('[data-testid="card-masthead-description"]');
           const head = path.querySelector(".tug-path-head");
           const tail = path.querySelector(".tug-path-tail");
           const measure = () => ({
             headClipped: head.scrollWidth > head.clientWidth,
             // A run whose glyphs all fit reports no overflow; the filename
             // must be one of those, which is the entire point of the split.
             tailWhole: tail.scrollWidth <= tail.clientWidth,
             // And the run still stops inside the line it was given — an
             // unshrinkable tail would push the path out under the pane's
             // controls instead of clipping.
             withinLine:
               Math.round(path.getBoundingClientRect().right) <=
               Math.round(path.parentElement.getBoundingClientRect().right) + 1,
           });
           const natural = measure();
           const previous = path.style.maxInlineSize;
           path.style.maxInlineSize = "220px";
           const squeezed = measure();
           path.style.maxInlineSize = previous;
           return {
             head: head.textContent,
             tail: tail.textContent,
             natural,
             squeezed,
           };
         })()`);
        note("at0310 path truncation", JSON.stringify(truncation));
        // Both runs are real text whatever the box does, so the path stays
        // whole to a reader who copies it out of the DOM.
        expect(truncation.tail).toBe("/gradient.png");
        expect(truncation.head + truncation.tail).toBe(file);
        expect(truncation.natural.tailWhole).toBe(true);
        expect(truncation.natural.withinLine).toBe(true);
        expect(truncation.squeezed.headClipped, "the directory chain gives way").toBe(
          true,
        );
        expect(truncation.squeezed.tailWhole, "the filename survives").toBe(true);
        expect(truncation.squeezed.withinLine).toBe(true);

        // The card's one verb stands in its pane's title bar as its own
        // button. Membership is the card's to publish; the control's label
        // and enablement are the command table's.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(
               '[data-testid="tug-pane-title-bar-item-reveal-card-file"]').length`,
          ),
        ).toBe(1);

        const viewerCardId = await app.evalJS<string>(
          `window.tugdeck.diag.getDeckState().cards.find(
            (c) => c.componentId === "file-view",
          ).id`,
        );

        // ---- Opening the same path again fronts that card, never a second.
        await app.dispatchControlAction("open-file", { path: file });
        expect(await app.evalJS<number>(countByComponent("file-view"))).toBe(1);
        expect(await app.getActiveCardId()).toBe(viewerCardId);

        // ---- The Cards card's Files group lists it, read-only.
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("toggle-cards"), null)`,
        );
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${ROW_TITLE}');
            return el !== null && el.innerText.indexOf("gradient.png") !== -1;
          })()`,
          { timeoutMs: 15_000 },
        );
        // A viewer has no dirty state to report, so the row never wears the
        // dot a manual-mode Text card wears.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('${UNSAVED_DOT}') === null`,
          ),
        ).toBe(true);
        // The kind glyph is the only thing telling an image row apart from a
        // text row, so it has to actually render.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('${ROW_GLYPH} svg') !== null`,
          ),
        ).toBe(true);

        // ---- The row's close box closes the viewer.
        await app.evalJS<null>(
          `(document.querySelector('${ROW_CLOSE}').click(), null)`,
        );
        await app.waitForCondition<boolean>(
          `${countByComponent("file-view")} === 0`,
          { timeoutMs: 8_000 },
        );
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a PDF renders real page pixels through pdf.js",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0310-pdf-"));
      const file = path.join(dir, "two-pages.pdf");
      fs.writeFileSync(file, encodePdf());
      const blobHref = `/api/fs/blob?path=${encodeURIComponent(file)}`;

      const app = await launchTugApp({
        ...NO_AX,
        testName: "at0310-file-view-pdf",
      });
      try {
        await app.dispatchControlAction("open-file", { path: file });
        await app.waitForCondition<boolean>(
          `${countByComponent("file-view")} === 1`,
          { timeoutMs: 15_000 },
        );
        // The same card family takes the PDF — one viewer, kind-branched body.
        await app.waitForCondition<boolean>(
          `document.querySelector('${CARD_PDF}') !== null`,
          { timeoutMs: 15_000 },
        );

        // The route serves it as a PDF. pdf.js no longer needs WebKit to
        // recognize the type, but the header is the contract the blob route
        // publishes and a viewer regression would show up here first. The
        // fetch parks its result on a global: `evalJS` marshals values, not
        // promises, so the await happens on this side as a poll.
        await app.evalJS<null>(
          `(window.__at0310Probe = null,
            fetch(${JSON.stringify(blobHref)}).then(function (r) {
              window.__at0310Probe = r.status + " " + r.headers.get("content-type");
            }),
            null)`,
        );
        await app.waitForCondition<boolean>(
          `window.__at0310Probe !== null`,
          { timeoutMs: 10_000 },
        );
        expect(await app.evalJS<string>(`window.__at0310Probe`)).toBe(
          "200 application/pdf",
        );

        // A page reports "rendered" only after pdf.js has drawn its canvas
        // and laid out its text — a worker that failed to load never gets
        // here.
        await app.waitForCondition<boolean>(
          `document.querySelector('${CARD_PAGE}[data-pdf-page-status="rendered"]') !== null`,
          { timeoutMs: 30_000 },
        );

        // The load-bearing assertion: real ink on the page canvas. A canvas
        // that mounted but never painted is exactly what a broken worker
        // produces, and an element-presence check would sail past it, so the
        // pixels are sampled and required to be non-uniform.
        const distinctPixels = await app.evalJS<number>(
          `(function () {
             var canvas = document.querySelector('${CARD_CANVAS}');
             var ctx = canvas.getContext("2d");
             var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
             var seen = Object.create(null);
             for (var i = 0; i < data.length; i += 4) {
               seen[data[i] + "," + data[i + 1] + "," + data[i + 2]] = true;
             }
             return Object.keys(seen).length;
           })()`,
        );
        expect(distinctPixels).toBeGreaterThan(1);

        // The masthead's third line counts the pages, which only the surface
        // knows: `PdfView` reports `doc.numPages` up to the card once the
        // document resolves, and the card republishes through the same
        // equality-guarded `set`. Waited for rather than read, because the
        // count arrives after the tier does — which is the point of [P11]:
        // the height was already 72 before this line had anything to say.
        expect(await paneTier(app)).toBeCloseTo(72, 0);
        await app.waitForCondition<boolean>(
          `(() => {
             const card = document.querySelector('[data-slot="file-view-card"]');
             const el = card.closest(".tug-pane")
               .querySelector('[data-testid="card-masthead-detail"]');
             return el !== null && el.innerText === "PDF · 2 pages";
           })()`,
          { timeoutMs: 15_000 },
        );
        expect(await mastheadLine(app, "card-masthead-title")).toBe("two-pages.pdf");

        // pdf.js's text layer is what makes the rendering selectable rather
        // than a picture of a document. Selecting across its spans and
        // reading the selection back is the end-to-end check: the text is
        // present, positioned, and reachable by a real DOM selection.
        const selected = await app.evalJS<string>(
          `(function () {
             var layer = document.querySelector('${CARD_PAGE} .textLayer');
             var range = document.createRange();
             range.selectNodeContents(layer);
             var selection = window.getSelection();
             selection.removeAllRanges();
             selection.addRange(range);
             var text = String(selection.toString());
             selection.removeAllRanges();
             return text;
           })()`,
        );
        expect(selected).toContain("Page One");

        // The surface fills the card rather than collapsing to zero height —
        // the layout half of "the viewer is usable".
        const width = await app.evalJS<number>(
          `document.querySelector('${CARD_PDF}').getBoundingClientRect().width`,
        );
        const height = await app.evalJS<number>(
          `document.querySelector('${CARD_PDF}').getBoundingClientRect().height`,
        );
        expect(width).toBeGreaterThan(200);
        expect(height).toBeGreaterThan(200);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

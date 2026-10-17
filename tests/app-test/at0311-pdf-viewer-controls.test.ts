/**
 * at0311-pdf-viewer-controls.test.ts — the PDF surface's keyboard contract,
 * page modes, and card-scoped zoom, driven by real keystrokes in the real app.
 *
 * ## What this gates
 *
 * The reasons the viewer stopped using WebKit's built-in PDF plugin. Each was
 * measured as broken against the embed, so each is asserted here against the
 * replacement:
 *
 *   1. **Arrow keys and paging do something.** The embed swallowed them —
 *      eight ArrowDowns produced byte-identical screenshots. Here they move
 *      the scroll offset, and Home / End reach the document's ends.
 *   2. **The page modes exist at all.** Continuous Scroll / Single Page /
 *      Two Pages, each chosen from the context menu, change the laid-out
 *      geometry to match — one page, or two side by side at the same top
 *      edge. They carry no chord by design (Preview's ⌘1-3 are the deck's
 *      `move-to-slot`), so the menu is the whole interface and this is the
 *      only place they are proven to work. ⌘1 with a PDF frontmost is
 *      asserted to leave the mode alone.
 *   3. **Zoom scales the document, not the app.** The host's Zoom In command
 *      grows the page canvas while the deck's own layout metrics stay put.
 *      The chord itself belongs to AppKit and never reaches the web view, so
 *      the command is exercised the way the menu delivers it.
 *
 * The keys and clicks are posted natively rather than synthesized in JS: the
 * chain resolves keys through the capture-phase pipeline against the first
 * responder, and a synthesized event would prove the handler runs without
 * proving the key ever gets there. The same goes for the menu — a real
 * right-click is the gesture the old embed swallowed.
 *
 * The document is encoded at test time rather than checked in, so the repo
 * carries no binary fixture.
 *
 * @covers tugdeck/src/components/tugways/cards/pdf-view.tsx
 * @covers tugdeck/src/lib/pdf-layout.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp } from "./_harness";
import { waitForBodyPainted } from "./_harness/card-reach";
import { encodePdf } from "./fixtures/pdf";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const NO_AX = { skipAccessibilityPreflight: true } as const;

const SURFACE = '[data-slot="file-view-pdf"]';
const PAGE = `${SURFACE} [data-slot="pdf-page"]`;
const RENDERED = `${PAGE}[data-pdf-page-status="rendered"]`;

/** A four-page document, so paging has somewhere to go. */
const PAGE_COUNT = 4;

/** The laid-out pages: their numbers and boxes, straight from the DOM. */
const PAGE_GEOMETRY = `(function () {
  return JSON.stringify(
    Array.from(document.querySelectorAll('${PAGE}')).map(function (el) {
      var box = el.getBoundingClientRect();
      return {
        page: Number(el.dataset.pdfPage),
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
      };
    }),
  );
})()`;

interface PageBox {
  page: number;
  left: number;
  top: number;
  width: number;
}

describe.skipIf(!SHOULD_RUN)("at0311 — the PDF surface answers the keyboard", () => {
  test(
    "arrows scroll, the menu switches page modes, and zoom stays inside the card",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0311-"));
      const file = path.join(dir, "four-pages.pdf");
      fs.writeFileSync(file, encodePdf(PAGE_COUNT));

      const app = await launchTugApp({
        ...NO_AX,
        testName: "at0311-pdf-viewer-controls",
      });
      try {
        await app.dispatchControlAction("open-file", { path: file });
        // The viewer is its own body: the surface, its pages and its context
        // menu are read and clicked in its page. Painted and placed, so a
        // native click aims at a view that has a size.
        const viewer = await waitForBodyPainted(app, "file-view", 15_000);
        await viewer.waitForCondition<boolean>(
          `document.querySelector('${RENDERED}') !== null`,
          { timeoutMs: 30_000 },
        );

        // A click into the surface is how a reader starts: it promotes the
        // surface to first responder, which is the seat the keys dispatch
        // from.
        await viewer.nativeClickAtElement(SURFACE);

        const scrollTop = (): Promise<number> =>
          viewer.evalJS<number>(`document.querySelector('${SURFACE}').scrollTop`);
        const geometry = async (): Promise<PageBox[]> =>
          JSON.parse(await viewer.evalJS<string>(PAGE_GEOMETRY)) as PageBox[];

        /**
         * Right-click the document and pick a menu row by its label, clicked
         * natively at the row's own centre. The rows carry no stable selector
         * of their own, so the point comes from the row a reader would aim at.
         */
        const chooseMode = async (label: string): Promise<void> => {
          await viewer.nativeRightClickAtElement(SURFACE);
          await viewer.waitForCondition<boolean>(
            `document.querySelectorAll(".tug-menu-item").length > 0`,
            { timeoutMs: 5_000 },
          );
          const point = JSON.parse(
            await viewer.evalJS<string>(
              `(function () {
                 var row = Array.from(document.querySelectorAll(".tug-menu-item"))
                   .find(function (el) {
                     var text = el.querySelector(".tug-menu-item-label");
                     return text && text.textContent === ${JSON.stringify(label)};
                   });
                 var box = row.getBoundingClientRect();
                 return JSON.stringify({
                   x: Math.round(box.left + box.width / 2),
                   y: Math.round(box.top + box.height / 2),
                 });
               })()`,
            ),
          ) as { x: number; y: number };
          await viewer.nativeClick(point);
          await viewer.waitForCondition<boolean>(
            `document.querySelectorAll(".tug-menu-item").length === 0`,
            { timeoutMs: 5_000 },
          );
        };

        // ---- Arrows and paging move the document.

        expect(await scrollTop()).toBe(0);
        for (let i = 0; i < 4; i += 1) await app.nativeKey("ArrowDown");
        const afterArrows = await scrollTop();
        expect(afterArrows).toBeGreaterThan(0);

        await app.nativeKey("PageDown");
        expect(await scrollTop()).toBeGreaterThan(afterArrows);

        await app.nativeKey("End");
        const atEnd = await scrollTop();
        await app.nativeKey("Home");
        expect(await scrollTop()).toBe(0);
        expect(atEnd).toBeGreaterThan(afterArrows);

        // ---- The page modes, reached the only way they can be reached.
        //
        // They carry no chord on purpose: Preview's ⌘1-3 are `move-to-slot`
        // here, and a viewer does not get to redefine a deck-wide navigation
        // command. The menu is the whole interface, so this is where the
        // modes are proven to work at all.

        await chooseMode("Single Page");
        const single = await geometry();
        expect(single).toHaveLength(1);

        // A pair sits side by side and level with each other.
        await chooseMode("Two Pages");
        const spread = await geometry();
        expect(spread).toHaveLength(2);
        expect(spread[1].left).toBeGreaterThan(spread[0].left);
        expect(spread[1].top).toBe(spread[0].top);

        // And back to the whole document in one column.
        await chooseMode("Continuous Scroll");
        const continuous = await geometry();
        expect(continuous.length).toBeGreaterThan(1);
        expect(continuous[1].top).toBeGreaterThan(continuous[0].top);
        expect(continuous[1].left).toBe(continuous[0].left);

        // ⌘1 belongs to the deck, not to the viewer: with a PDF frontmost it
        // still means "first tab" and must leave the page mode alone.
        await app.nativeKey("1", ["cmd"]);
        expect(
          await viewer.evalJS<string>(
            `String(document.querySelector('${SURFACE}').dataset.pdfPageMode)`,
          ),
        ).toBe("continuous");

        // ---- Zoom scales the document and leaves the app alone.
        //
        // The host owns ⌘+ and forwards it as a control action while the
        // surface's `menuState.document` claim stands, so that is how it is
        // delivered here. A native chord would be intercepted by AppKit
        // before the web view and would prove nothing about the deck.
        // card-dom: shell — the deck's own layout is the shell's document.
        const deckWidthBefore = await app.evalJS<number>(
          `Math.round(document.documentElement.getBoundingClientRect().width)`,
        );
        const pageWidthBefore = (await geometry())[0].width;

        // The real chord, posted natively: AppKit resolves it against the
        // View menu, the delegate sees the surface's claim and forwards
        // `zoom-in` instead of scaling the web view. This is the half that a
        // deck-only test cannot reach.
        await app.nativeKey("+", ["cmd"]);
        await viewer.waitForCondition<boolean>(
          `document.querySelector('${PAGE}').getBoundingClientRect().width > ${pageWidthBefore + 1}`,
          { timeoutMs: 5_000 },
        );
        // The claim is what made that chord reach the deck at all.
        expect(
          await viewer.evalJS<string>(
            `String(document.querySelector('${SURFACE}').dataset.pdfZoom)`,
          ),
        ).not.toBe("fit-width");

        // card-dom: shell — the deck's own layout is the shell's document.
        const deckWidthAfter = await app.evalJS<number>(
          `Math.round(document.documentElement.getBoundingClientRect().width)`,
        );
        expect(deckWidthAfter).toBe(deckWidthBefore);

        // ---- Actual size is a real destination, not just "smaller".

        await app.nativeKey("0", ["cmd"]);
        // Wait on the zoom the surface reports, not on a page being
        // rendered: the pages drawn at the previous scale still report
        // "rendered" until they are redrawn, so that condition is already
        // true and would let the assertion read the old geometry.
        await viewer.waitForCondition<boolean>(
          `document.querySelector('${SURFACE}').dataset.pdfZoom === "1.00"`,
          { timeoutMs: 10_000 },
        );
        // US Letter at 72dpi is 612 points wide, and actual size means
        // exactly that many CSS pixels.
        const actual = await geometry();
        expect(actual[0].width).toBe(612);

        // ---- The right-click control surface.
        //
        // The reason the embed had to go: WebKit swallowed the right-click
        // before JS ever saw it, so there was no menu to hang these on.

        await viewer.nativeRightClickAtElement(SURFACE);
        await viewer.waitForCondition<boolean>(
          `document.querySelectorAll(".tug-menu-item").length > 0`,
          { timeoutMs: 5_000 },
        );
        const menu = JSON.parse(
          await viewer.evalJS<string>(
            `JSON.stringify(
               Array.from(document.querySelectorAll(".tug-menu-item")).map(function (el) {
                 var label = el.querySelector(".tug-menu-item-label");
                 return {
                   label: label ? label.textContent : el.textContent,
                   marked: el.querySelector("svg") !== null,
                 };
               }),
             )`,
          ),
        ) as { label: string; marked: boolean }[];

        const labels = menu.map((entry) => entry.label);
        expect(labels).toContain("Continuous Scroll");
        expect(labels).toContain("Single Page");
        expect(labels).toContain("Two Pages");
        expect(labels).toContain("Zoom In");
        expect(labels).toContain("Fit Width");

        // The marks track the live state, which is the whole point of
        // showing them: continuous mode and actual size are in force here.
        const marked = menu.filter((entry) => entry.marked).map((e) => e.label);
        expect(marked).toEqual(["Continuous Scroll", "Actual Size"]);

        // Dismiss without choosing — the menu is already open from the
        // inspection above, and the mode work below it is done.
        await app.nativeKey("Escape");
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

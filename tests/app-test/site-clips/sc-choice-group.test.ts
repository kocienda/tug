/**
 * sc-choice-group.test.ts — the site's TugChoiceGroup clip: the Component
 * Gallery's choice-group card, its animated group and its three icon groups
 * pressed segment by segment.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: the `gallery-choice-group` card in a one-up, scrolled so its
 * Animated section leads and cropped to that section and the Icons section
 * under it. The animated group goes Grid, List, Table, Grid, the indicator
 * sliding each time; then the icon groups take a press each — a label with
 * its icon on the left, on the right, and icon-only.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor } from "./_site-clips";
import { galleryDeck, inWindow, press, scrollSectionToTop, sectionRects, sectionSel, waitForGallery } from "./_components";

const TEST_TIMEOUT_MS = 110_000;
const CARD = "sc-choice";
const BURST_MS = 9_600;
const SECTIONS = ["Animated", "Icons"];
/** The crop's width: the widest group and its label, not the card's empty right half. */
const CROP_WIDTH = 448;
/** Above the leading section is the card's title bar, so the crop starts just over the section. */
const TOP_PAD = 6;
/** A segment in the section named: the Instant section above has a List of its own. */
const segment = (section: string): string => `${sectionSel(section)} [role="radio"]`;

describe.skipIf(!RUNS)("site clip: choice group", () => {
  test(
    "records the gallery's choice groups taking presses",
    async () => {
      const app = await launchForMode("sc-choice-group", galleryDeck(CARD, "gallery-choice-group", "TugChoiceGroup"));
      try {
        const body = app.body(CARD);
        await waitForGallery(body, "gallery-choice-group");
        await Bun.sleep(600);
        await scrollSectionToTop(body, SECTIONS[0]!);
        await Bun.sleep(600);
        const view = (await app.bodies()).find((b) => b.cardId === CARD)!.frame;
        const rects = await sectionRects(body, SECTIONS);
        const wide = cropAround(rects.map((r) => inWindow(view, r)), 16, await contentSize(app));
        const top = inWindow(view, rects[0]!).y - TOP_PAD;
        const crop = { x: wide.x, y: top, width: Math.min(wide.width, CROP_WIDTH), height: wide.y + wide.height - top };

        const reading = await burstTo(app, crop, BURST_MS, outDirFor("choice-group"), async () => {
          await Bun.sleep(700);
          for (const label of ["List", "Table", "Grid"]) {
            await press(body, segment("Animated"), { text: label });
            await Bun.sleep(950);
          }
          for (const label of ["Italic", "Underline", "Center", "Right"]) {
            await press(body, segment("Icons"), { text: label });
            await Bun.sleep(800);
          }
          for (const name of ["Dark", "System"]) {
            await press(body, `${segment("Icons")}[aria-label="${name}"]`, { index: 0 });
            await Bun.sleep(800);
          }
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

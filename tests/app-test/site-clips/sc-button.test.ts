/**
 * sc-button.test.ts — the site's TugButton clip: the Component Gallery's
 * button card, its preview controls driven one at a time, and the three
 * preview buttons changing with them.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: the `gallery-buttons` card in a one-up, cropped to its Preview
 * Controls and Interactive Preview sections. Emphasis goes from outlined to
 * filled, the role to danger, the size to lg, each through its popup button;
 * then Loading and Disabled are checked and cleared. The three buttons below — text,
 * icon, icon and text — take every change together.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor } from "./_site-clips";
import { TARGET_SEL, aim, galleryDeck, inWindow, press, sectionRects, waitForGallery } from "./_components";

const TEST_TIMEOUT_MS = 110_000;
const CARD = "sc-button";
const BURST_MS = 9_600;
const MENU_ITEM = ".tug-menu-item";
const CHECKBOX = '[data-slot="tug-checkbox"]';
const SECTIONS = ["Preview Controls", "TugPushButton — Interactive Preview"];
/** The crop's width: the controls and the lg preview row, not the card's empty right half. */
const CROP_WIDTH = 480;

/** Open the popup whose label reads `label`, then pick `item` from it. */
async function pick(body: Parameters<typeof press>[0], label: string, item: string): Promise<void> {
  await press(body, "button", { text: label });
  await Bun.sleep(650);
  await aim(body, MENU_ITEM, { text: item });
  await body.nativeClickAtElement(TARGET_SEL);
}

describe.skipIf(!RUNS)("site clip: button", () => {
  test(
    "records the gallery's push button taking each preview control",
    async () => {
      const app = await launchForMode("sc-button", galleryDeck(CARD, "gallery-buttons", "TugPushButton"));
      try {
        const body = app.body(CARD);
        await waitForGallery(body, "gallery-buttons");
        await Bun.sleep(800);
        const view = (await app.bodies()).find((b) => b.cardId === CARD)!.frame;
        const rects = await sectionRects(body, SECTIONS);
        const wide = cropAround(rects.map((r) => inWindow(view, r)), 16, await contentSize(app));
        const crop = { ...wide, width: Math.min(wide.width, CROP_WIDTH) };

        const reading = await burstTo(app, crop, BURST_MS, outDirFor("button"), async () => {
          await Bun.sleep(700);
          await pick(body, "outlined", "filled");
          await Bun.sleep(1_000);
          await pick(body, "accent (default)", "danger");
          await Bun.sleep(1_000);
          await pick(body, "md", "lg");
          await Bun.sleep(1_000);
          // Loading on and off, then Disabled on and off, so the clip ends on
          // the three buttons as they were just set rather than greyed out.
          await press(body, CHECKBOX, { index: 1 });
          await Bun.sleep(1_000);
          await press(body, CHECKBOX, { index: 1 });
          await Bun.sleep(1_000);
          await press(body, CHECKBOX, { index: 0 });
          await Bun.sleep(1_000);
          await press(body, CHECKBOX, { index: 0 });
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

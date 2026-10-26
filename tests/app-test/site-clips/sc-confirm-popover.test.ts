/**
 * sc-confirm-popover.test.ts — the site's TugConfirmPopover clip: three
 * guarded buttons in the Component Gallery's confirm-popover card, each
 * pressed, each raising its popover, and each answered.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. Run by path, once per mode
 * (`_site-clips.ts` has the invocation); skips unless the runner and both
 * site variables are set.
 *
 * The scene: the `gallery-confirm-popover` card in a one-up, cropped to its
 * first three sections. Delete Item is pressed and the danger popover is
 * cancelled; Publish is pressed and confirmed; Discard Changes is pressed
 * and answered Keep Editing. Each section's result line records the answer.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";

import { pollFor } from "../body-grounding/_frames";
import { RUNS, burstTo, contentSize, cropAround, launchForMode, outDirFor } from "./_site-clips";
import { galleryDeck, inWindow, press, sectionRects, waitForGallery } from "./_components";

const TEST_TIMEOUT_MS = 110_000;
const CARD = "sc-confirm";
const BURST_MS = 9_600;
const POPOVER = '[data-slot="tug-confirm-popover"]';
const CONFIRM = '[data-slot="tug-confirm-confirm"]';
const CANCEL = '[data-slot="tug-confirm-cancel"]';
const SECTIONS = ["Danger Confirmation", "Action Confirmation", "Custom Labels"];
/** The popover rises below its button and reaches a little past the section's result line. */
const POPOVER_ROOM = 40;
/**
 * The popover's left edge sits left of its button's, past the card's own
 * edge, so the crop starts at the card's edge and the popover bleeds off it.
 */
const LEFT_ROOM = 6;
/** The crop's width: the buttons, their popovers and the result lines, not the card's empty right half. */
const CROP_WIDTH = 440;

describe.skipIf(!RUNS)("site clip: confirm popover", () => {
  test(
    "records three guarded buttons raising and answering their popovers",
    async () => {
      const app = await launchForMode("sc-confirm-popover", galleryDeck(CARD, "gallery-confirm-popover", "TugConfirmPopover"));
      try {
        const body = app.body(CARD);
        await waitForGallery(body, "gallery-confirm-popover");
        await Bun.sleep(800);
        const view = (await app.bodies()).find((b) => b.cardId === CARD)!.frame;
        const rects = await sectionRects(body, SECTIONS);
        const last = rects[rects.length - 1]!;
        const wide = cropAround([...rects.map((r) => inWindow(view, r)), inWindow(view, { ...last, height: last.height + POPOVER_ROOM })], 16, await contentSize(app));
        const left = Math.max(0, wide.x - LEFT_ROOM);
        const crop = { x: left, y: wide.y, width: Math.min(wide.x + wide.width, left + CROP_WIDTH) - left, height: wide.height };

        const raise = async (label: string): Promise<void> => {
          await press(body, "button", { text: label });
          await pollFor(() => body.evalJS<boolean>(`document.querySelector(${JSON.stringify(POPOVER)}) !== null`).catch(() => false), (up) => up, 5_000);
        };
        const reading = await burstTo(app, crop, BURST_MS, outDirFor("confirm-popover"), async () => {
          await Bun.sleep(700);
          await raise("Delete Item");
          await Bun.sleep(1_500);
          await body.nativeClickAtElement(CANCEL);
          await Bun.sleep(1_000);
          await raise("Publish");
          await Bun.sleep(1_500);
          await body.nativeClickAtElement(CONFIRM);
          await Bun.sleep(1_000);
          await raise("Discard Changes");
          await Bun.sleep(1_500);
          await body.nativeClickAtElement(CANCEL);
        });
        expect(reading.frames, "frames were recorded").toBeGreaterThan(60);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

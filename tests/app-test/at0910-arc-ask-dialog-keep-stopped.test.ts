/**
 * at0910-arc-ask-dialog-keep-stopped.test.ts — cancelling an arc's question
 * dialog is Keep Stopped: the arc stays stopped, and the record says so.
 *
 * The dialog's Cancel, confirmed, sends the same Keep Stopped act the old
 * inline buttons did. Nothing is answered and nothing resumes; the record's
 * last note says the user left it stopped.
 *
 * @family at0910
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 * @covers tugdeck/src/lib/arc-ask-question.ts
 * @covers tugdeck/src/components/tugways/chrome/session-question-dialog.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  askOnTheCard,
  askRecord,
  clickDialogButton,
  dropAskScene,
  makeAskScene,
  pollRecord,
  withAskCard,
  type AskScene,
} from "./arc-ask-dialog-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const SID = "a7c0d1ea-0000-4000-8000-000000000912";
/** `LEFT_STOPPED_NOTE` in `tugarc-core`. */
const LEFT_STOPPED = "the user left the arc stopped";
let scene: AskScene | null = null;

beforeAll(() => {
  if (SHOULD_RUN) scene = makeAskScene("at0910-keep", SID);
});
afterAll(() => {
  if (SHOULD_RUN) dropAskScene(scene);
});

describe.skipIf(!SHOULD_RUN)("AT0910: the ask's dialog cancel is Keep Stopped", () => {
  test("the arc stays stopped, unanswered, and the record says it was left", async () => {
    const s = scene!;
    await withAskCard(s, "at0910-arc-ask-dialog-keep-stopped", async (app) => {
      await askOnTheCard(app, s);
      const before = askRecord(s);
      expect(before.stopped?.[1]).toBe("needs a decision");

      await clickDialogButton(app, "Cancel");
      // The confirm popover lives outside the dialog's own subtree.
      await clickDialogButton(app, "Yes, cancel", "body");
      const after = await pollRecord(s, (r) => r.lastNote === LEFT_STOPPED);
      note("at0910 record after keep stopped", JSON.stringify(after));
      expect(after.lastNote).toBe(LEFT_STOPPED);
      expect(after.stopped?.[1]).toBe("needs a decision");
      expect(after.answer).toBeNull();
    });
  }, 120_000);
});

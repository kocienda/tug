/**
 * at0910-arc-ask-dialog-reply.test.ts — a typed reply in an arc's question
 * dialog is the answer, and it resumes the arc.
 *
 * The dialog's free-text field stands beside the options, as it does on every
 * question in the app. Words typed there win over the preselected option, and
 * Submit sends them through the same answer act a choice does.
 *
 * @family at0910
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 * @covers tugdeck/src/lib/arc-ask-question.ts
 * @covers tugdeck/src/components/tugways/chrome/session-question-dialog.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  FREE_TEXT,
  askOnTheCard,
  clickDialogButton,
  dialogGone,
  dropAskScene,
  makeAskScene,
  pollRecord,
  typeInto,
  withAskCard,
  type AskScene,
} from "./arc-ask-dialog-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const SID = "a7c0d1ea-0000-4000-8000-000000000911";
const REPLY = "neither, move the band";
let scene: AskScene | null = null;

beforeAll(() => {
  if (SHOULD_RUN) scene = makeAskScene("at0910-reply", SID);
});
afterAll(() => {
  if (SHOULD_RUN) dropAskScene(scene);
});

describe.skipIf(!SHOULD_RUN)("AT0910: a typed reply in the ask's dialog answers it", () => {
  test("the reply is recorded as the answer, and the arc resumes", async () => {
    const s = scene!;
    await withAskCard(s, "at0910-arc-ask-dialog-reply", async (app) => {
      await askOnTheCard(app, s);
      await typeInto(app, FREE_TEXT, REPLY);
      await clickDialogButton(app, "Submit");
      const after = await pollRecord(s, (r) => r.answer !== null && r.stopped === null);
      note("at0910 record after the reply", JSON.stringify(after));
      expect(after.answer).toBe(REPLY);
      expect(after.stopped).toBeNull();
      await dialogGone(app);
    });
  }, 120_000);
});

/**
 * at0910-arc-ask-composer-reply.test.ts — while an arc's question is up, the
 * card's composer is the reply.
 *
 * Text sent from the composer on the asking card is recorded as the answer
 * and resumes the arc, the same as the dialog's own reply — rather than
 * starting a turn in a stage the arc has stopped. The card knows a question
 * is up from the live arc model, the same read the dialog's pending makes.
 *
 * @family at0910
 * @covers tugdeck/src/components/tugways/cards/prompt-entry.tsx
 * @covers tugdeck/src/lib/arc-ask-question.ts
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  COMPOSER,
  askOnTheCard,
  dialogGone,
  dropAskScene,
  makeAskScene,
  pollRecord,
  typeInto,
  withAskCard,
  type AskScene,
} from "./arc-ask-dialog-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const SID = "a7c0d1ea-0000-4000-8000-000000000913";
const REPLY = "the neighbour, but only on wide screens";
let scene: AskScene | null = null;

beforeAll(() => {
  if (SHOULD_RUN) scene = makeAskScene("at0910-composer", SID);
});
afterAll(() => {
  if (SHOULD_RUN) dropAskScene(scene);
});

describe.skipIf(!SHOULD_RUN)("AT0910: the composer answers an arc's question", () => {
  test("a message sent while the question is up is the answer, and the arc resumes", async () => {
    const s = scene!;
    await withAskCard(s, "at0910-arc-ask-composer-reply", async (app) => {
      await askOnTheCard(app, s);
      await typeInto(app, COMPOSER, REPLY);
      // The composer's send chord; a bare Return is a newline there.
      await app.nativeKey("Enter", ["cmd"]);
      const after = await pollRecord(s, (r) => r.answer !== null && r.stopped === null);
      note("at0910 record after the composer reply", JSON.stringify(after));
      expect(after.answer).toBe(REPLY);
      expect(after.stopped).toBeNull();
      await dialogGone(app);
    });
  }, 120_000);
});

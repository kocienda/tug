/**
 * at0910-arc-ask-dialog-choice.test.ts — an arc's question is asked in the
 * app's question dialog, and choosing an option answers it and resumes.
 *
 * A stage that meets a decision stops its arc and leaves the question on the
 * stop receipt. The receipt hosts the same question dialog every other
 * question in the app is drawn by, built from the receipt's own text: each
 * choice an option with what it does, the recommended one first and
 * preselected, and what the stage verified apart from what it guessed. This
 * file reads the registers away from the receipt — the Z2 cell says `Asked`,
 * never `Stopped`, and the asking card names what stands between the arc and
 * its join — then presses Submit on the preselected recommendation and reads
 * the record: the answer is written and the stop is cleared. The reply, Keep Stopped and
 * the composer are the other `at0910` files.
 *
 * @family at0910
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 * @covers tugdeck/src/lib/arc-ask-question.ts
 * @covers tugdeck/src/lib/arc-receipt.ts
 * @covers tugdeck/src/lib/arc-track-model.ts
 * @covers tugdeck/src/lib/code-session-store/select-work.ts
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 * @covers tugdeck/src/components/tugways/chrome/session-question-dialog.tsx
 * @covers tugrust/crates/tugtool/src/arc.rs
 * @covers tugrust/crates/tugcast/src/arc_api.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note } from "./_harness";
import {
  ARC_CELL,
  ASK,
  NEW_ONE,
  ROUTE,
  askOnTheCard,
  clickDialogButton,
  dialogGone,
  dropAskScene,
  makeAskScene,
  pollRecord,
  textOnceItHolds,
  withAskCard,
  type AskScene,
} from "./arc-ask-dialog-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const SID = "a7c0d1ea-0000-4000-8000-000000000910";
let scene: AskScene | null = null;

beforeAll(() => {
  if (SHOULD_RUN) scene = makeAskScene("at0910-choice", SID);
});
afterAll(() => {
  if (SHOULD_RUN) dropAskScene(scene);
});

describe.skipIf(!SHOULD_RUN)("AT0910: a choice in the ask's dialog answers it", () => {
  test("the dialog offers the described choices, and Submit answers and resumes", async () => {
    const s = scene!;
    await withAskCard(s, "at0910-arc-ask-dialog-choice", async (app) => {
      await askOnTheCard(app, s);

      // The dialog was built from the receipt: the recommended option first,
      // with what it does; the evidence sorted above it.
      const shown = await app.body("A").evalJS<string>(
        `document.querySelector(${JSON.stringify(ASK)})?.textContent ?? ""`,
      );
      note("at0910 ask text", shown);
      expect(shown).toContain("Recommended — adds a cover of its own");
      expect(shown).toContain("widens the neighbour over the band");
      expect(shown).toContain("Verified the neighbour reaches the band");
      expect(shown).toContain("Guessed the flash is the band");
      // The recommendation is offered first, ahead of the stage's first choice.
      expect(shown.indexOf("adds a cover of its own")).toBeLessThan(
        shown.indexOf("widens the neighbour over the band"),
      );

      // Away from the receipt the ask is a question, not a fault: the Z2 cell
      // reads `Asked`, and the card names the road left to the join.
      const cell = await textOnceItHolds(app, ARC_CELL, "Asked");
      note("at0910 arc cell", cell);
      expect(cell).not.toContain("Stopped");
      const route = await textOnceItHolds(app, ROUTE, "join");
      note("at0910 route", route);
      expect(route.endsWith("join")).toBe(true);

      await clickDialogButton(app, "Submit");
      const after = await pollRecord(s, (r) => r.answer !== null && r.stopped === null);
      note("at0910 record after the choice", JSON.stringify(after));
      expect(after.answer).toBe(NEW_ONE);
      expect(after.stopped).toBeNull();
      await dialogGone(app);
    });
  }, 120_000);
});

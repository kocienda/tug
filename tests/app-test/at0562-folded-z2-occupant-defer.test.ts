/**
 * at0562-folded-z2-occupant-defer.test.ts — a permission arriving on a folded card gets the deferred notice in the Z2 row, and Unfold reveals the dialog that was mounted all along.
 *
 * One of the at0562-folded-z2-occupant split, a test to a file so each
 * launch fits its own budget. Why a folded card's Z2 row carries one
 * occupant, and the shared seed and readers, are
 * `folded-z2-occupant-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-compaction-run.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.css
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/lib/compaction-progress-store.ts
 * @covers tugdeck/src/lib/card-fold.ts
 * @covers tugdeck/src/lib/card-modal-hold-store.ts
 * @family at0562-folded-z2-occupant
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  SID,
  CODE_OUTPUT_FEED,
  ROW,
  OCCUPANT,
  OCCUPANT_ACTION,
  DIALOG,
  readRow,
  seed,
} from "./folded-z2-occupant-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0562: a folded card's Z2 row carries its one occupant",
  () => {
    test(
      "a permission arriving on a folded card gets the deferred notice, and Unfold reveals the dialog",
      async () => {
        const app = await launchTugApp({ testName: "at0562-folded-defer" });
        try {
          await seed(app);

          // The dialog mounts in the transcript FIRST, exactly as it does on
          // an open card — nothing about the arrival path changes. Then the
          // card folds, which is what puts the transcript out of sight.
          await app.driveSession("A", {
            op: "send",
            text: "count lines with tokei",
          });
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "control_request_forward",
              tug_session_id: SID,
              request_id: "at0562-perm-1",
              is_question: false,
              tool_name: "Bash",
              input: { command: "tokei" },
            },
          });
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
            { timeoutMs: 8000 },
          );

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-card-fold"), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.__tug.getPaneRecord("p1").folded === true`,
            { timeoutMs: 8000 },
          );
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OCCUPANT)}) !== null`,
            { timeoutMs: 8000 },
          );

          const notice = await readRow(app);
          note("at0562 folded, permission pending", notice);
          expect(notice.occupant).toBe("permission");
          expect(notice.text).toContain("Permission");
          expect(notice.text, "the Unfold action rides the notice").toContain(
            "Unfold",
          );
          expect(notice.hasBar, "a notice is not a run").toBe(false);
          expect(notice.cellsMounted).toBeGreaterThan(0);
          expect(notice.cellsShown, "the instruments stand down").toBe(0);
          expect(notice.sheets, "a deferred arrival raises no panel").toBe(0);
          expect(notice.folded, "and does not open the fold itself").toBe(true);
          note("at0562 folded defer notice", (await app.screenshot()).path);

          // The press is the whole of the interaction: the card opens and the
          // dialog that was mounted all along is simply on show again.
          await app.body("A").evalJS<null>(
            `(document.querySelector(${JSON.stringify(OCCUPANT_ACTION)}).click(), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.__tug.getPaneRecord("p1").folded === false`,
            { timeoutMs: 8000 },
          );
          // The shell's deck flips first; the body hears the unfold on the
          // bus a beat later, and its row gives the seat back then.
          await app.body("A").waitForCondition<boolean>(
            `(function(){ var row = document.querySelector(${JSON.stringify(ROW)}); return row === null || !row.hasAttribute("data-occupant"); })()`,
            { timeoutMs: 4000 },
          );
          const opened = await readRow(app);
          note("at0562 unfolded by the notice", opened);
          expect(opened.occupant, "the row is the instruments' again").toBeNull();
          expect(opened.cellsShown).toBe(opened.cellsMounted);
          expect(
            await app.body("A").evalJS<boolean>(
              `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
            ),
            "the request is still pending, now visible",
          ).toBe(true);

          // Nothing was answered, so folding again brings the notice straight
          // back — it tracks the pending state and holds no dismissal of its
          // own.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-card-fold"), null)`,
          );
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OCCUPANT)}) !== null`,
            { timeoutMs: 8000 },
          );
          const again = await readRow(app);
          note("at0562 refolded, still pending", again);
          expect(again.occupant).toBe("permission");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

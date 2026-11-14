/**
 * at0562-folded-z2-occupant-open.test.ts — the same compaction on an OPEN card raises its cover rather than the row, its hold admits the fold, and the fold/unfold handoff shows a face on every frame (it records frames, so it runs alone).
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
 * @motion
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  SHEET,
  OCCUPANT_ACTION,
  FOLD_CONTROL,
  readRow,
  seed,
  sendWheelCompact,
  armHandoffRecorder,
  readHandoffRecord,
} from "./folded-z2-occupant-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0562: a folded card's Z2 row carries its one occupant",
  () => {
    test(
      "the same compaction on an OPEN card raises its cover, and its hold admits the fold",
      async () => {
        const app = await launchTugApp({ testName: "at0562-open-compaction" });
        try {
          await seed(app);
          await sendWheelCompact(app);
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector('[data-slot="compaction-progress"]') !== null`,
            { timeoutMs: 8000 },
          );
          const open = await readRow(app);
          note("at0562 open, compacting", open);
          expect(open.sheets).toBe(1);
          // The run's row face is MOUNTED behind the cover ([B05]) — in the
          // tree, hidden, so the fold ahead changes an attribute rather than
          // mounting it — and the instruments stand while it is behind.
          expect(open.occupant).toBe("compaction");
          expect(open.face, "the row's face is behind the cover").toBe("behind");
          expect(open.occupantShown, "and the occupant is not laid out").toBe(
            false,
          );
          expect(open.cellsShown).toBe(open.cellsMounted);

          // Folding under the cover PASSES, and that is the hold speaking
          // rather than the fold rule. A run takes `cardModalHoldStore` for as
          // long as it needs the card, and every door that finds one stops and
          // lets the holder say why ([L31]) — but the fold is the one door a
          // holder may admit, because folding does not leave a run: it swaps
          // the face the run is shown on, from the cover panel to the Z2 row,
          // with the same Cancel on both ([B02]). The compaction's hold is the
          // only one that says so; every other door on this card still meets
          // the refusal, which the sibling `at0492` reads.
          //
          // The card is made first responder first, so the gesture is DELIVERED
          // rather than merely lost: a cover autofocuses its own panel, and a
          // fold that never reached the card's handler would read here exactly
          // like one the hold turned away.
          //
          // And it is performed by CLICKING the fold control rather than by
          // dispatching the command, because the click is what puts the key
          // view on a button other than the row's Cancel — the case the ring
          // assertion below exists for.
          //
          // The FOLD is recorded frame by frame as well ([B06]/[B07]): the
          // cover holds through the crossing's opening portion and lowers over
          // its closing portion while the row is arriving, so on no frame is
          // the run faceless and on some frames it wears both.
          await app.evalJS<null>(`(window.__tug.setFirstResponder("A"), null)`);
          await armHandoffRecorder(
            app,
            `face === "showing" && !crossing && occ >= 0.98 && sheet === 0`,
          );
          await app.body("A").evalJS<null>(
            `(document.querySelector(${JSON.stringify(FOLD_CONTROL)}).click(), null)`,
          );
          const foldRec = await readHandoffRecord(app);
          note("at0562 fold, frame record", foldRec);
          expect(foldRec.frames, "the fold reached its face").toBeLessThan(900);
          expect(
            foldRec.gapFrames,
            "no frame of the fold shows neither face",
          ).toBe(0);
          expect(
            foldRec.overlapFrames,
            "and the two faces overlap for a beat",
          ).toBeGreaterThan(0);
          const held = await readRow(app);
          note("at0562 fold under a live cover", held);
          expect(held.folded, "the hold admits the fold").toBe(true);
          expect(
            held.occupant,
            "and the row takes the run's other face",
          ).toBe("compaction");
          expect(held.text, "which reads the run and offers its Cancel").toContain(
            "Compacting",
          );
          expect(held.face, "the row is the run's showing face").toBe("showing");
          expect(held.occupantShown).toBe(true);
          // The sheet's Cancel, exactly ([B02]): the row seeds the key view
          // onto its Cancel the way the cover seeds it onto its own, and pushes
          // the same trapped focus mode the cover is — which is what engages
          // keyboard-focus painting, so the button wears the filled fill and
          // the double ring. The fold control held the key view a moment ago,
          // by the click above, and the card's own fold reclaim would have
          // handed it back there; while a run is in flight the reclaim lands
          // on Cancel instead. Return on this folded compacting card therefore
          // means Cancel, as it does on the open one. `keyViewHolder` names
          // the element holding the key view so a failure says WHO has it.
          const readRing = () => app.body("A").evalJS<{
            defaultRing: boolean;
            keyView: boolean;
            keyViewHolder: string | null;
            defaultRingHolder: string | null;
            active: string | null;
          }>(
            `(function(){
              function describe(el) {
                if (el === null || el === undefined) return null;
                return el.tagName.toLowerCase() +
                  (el.className ? "." + String(el.className).split(" ").slice(0, 2).join(".") : "") +
                  (el.getAttribute("aria-label") ? "[" + el.getAttribute("aria-label") + "]" : "") +
                  (el.textContent ? "{" + el.textContent.trim().slice(0, 20) + "}" : "");
              }
              var b = document.querySelector(${JSON.stringify(OCCUPANT_ACTION)});
              return {
                defaultRing: b !== null && b.hasAttribute("data-default-ring"),
                keyView: b !== null && b.hasAttribute("data-key-view-kbd"),
                keyViewHolder: describe(document.querySelector("[data-key-view]")),
                defaultRingHolder: describe(document.querySelector("[data-default-ring]")),
                active: describe(document.activeElement),
              };
            })()`,
          );
          await app.body("A").waitForCondition<boolean>(
            `(function(){
              var b = document.querySelector(${JSON.stringify(OCCUPANT_ACTION)});
              return b !== null &&
                (b.hasAttribute("data-default-ring") ||
                 b.hasAttribute("data-key-view-kbd"));
            })()`,
            { timeoutMs: 6000 },
          );
          const ring = await readRing();
          note("at0562 row Cancel ring after a clicked fold", ring);
          expect(
            ring.defaultRing || ring.keyView,
            "the row's Cancel is the card's live default — filled, double ring",
          ).toBe(true);

          // The UNFOLD, watched frame by frame ([B05]/[F04]/[B06]). The
          // occupant must be the same element before and after — a face that
          // unmounted and mounted again re-arms its arrival under its
          // departure, which is the stumble — and no frame inside the crossing
          // may show the instruments: the row is the run's only face until the
          // cover rises out of it. The row holds full opacity through the
          // opening portion, fades over the closing one on a window that runs
          // past the end event by the cover's rise, and the cover rises at the
          // end event — so no frame is faceless and some carry both. The
          // recorder is armed BEFORE the click so the first committed frame is
          // in the record, and runs until the face is `behind` and the cover
          // has fully risen.
          await armHandoffRecorder(
            app,
            `face === "behind" && !crossing && sheet >= 0.98`,
          );
          await app.body("A").evalJS<null>(
            `(document.querySelector(${JSON.stringify(FOLD_CONTROL)}).click(), null)`,
          );
          const unfold = await readHandoffRecord(app);
          note("at0562 unfold, frame record", unfold);
          expect(unfold.frames, "the unfold reached its face").toBeLessThan(900);
          expect(
            unfold.identityKept,
            "the occupant is the same element across the unfold",
          ).toBe(true);
          expect(
            unfold.cellFramesInCrossing,
            "no frame inside the crossing shows the instruments",
          ).toBe(0);
          expect(unfold.faces[unfold.faces.length - 1]).toBe("behind");
          expect(
            unfold.gapFrames,
            "no frame of the unfold shows neither face",
          ).toBe(0);
          expect(
            unfold.overlapFrames,
            "and the row is still on screen while the cover rises",
          ).toBeGreaterThan(0);
          // And the cover is the run's face again, over an open card whose
          // instruments are back.
          await app.body("A").waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHEET)}).length === 1`,
            { timeoutMs: 8000 },
          );
          const reopened = await readRow(app);
          note("at0562 unfolded under the run", reopened);
          expect(reopened.folded).toBe(false);
          expect(reopened.occupant).toBe("compaction");
          expect(reopened.face).toBe("behind");
          expect(reopened.occupantShown).toBe(false);
          expect(reopened.cellsShown).toBe(reopened.cellsMounted);

          // MOTION OFF: the same two crossings with nothing to ride. The fold
          // is a layout snap and the handoff snaps with it — the row is simply
          // the face when the card is folded and the cover is simply the face
          // when it is open; the row never `leaves`, it goes straight
          // `behind`. What still holds is that no frame is faceless.
          //
          // The card is made first responder again before each press: the
          // cover's re-raise autofocused its own panel, and the fold command
          // is routed to the first responder — a press that never reached the
          // card would run the recorder to its cap and prove nothing, which
          // is why the cap is asserted against below.
          await app.evalJS<null>(
            `(document.documentElement.style.setProperty("--tug-motion", "0"), null)`,
          );
          // The row's face is decided in A's body, which reads its own page's
          // motion flag, so it is turned off there too.
          await app.body("A").evalJS<null>(
            `(document.documentElement.style.setProperty("--tug-motion", "0"), null)`,
          );
          await app.evalJS<null>(`(window.__tug.setFirstResponder("A"), null)`);
          await armHandoffRecorder(
            app,
            `face === "showing" && occ >= 0.98 && sheet === 0`,
          );
          await app.body("A").evalJS<null>(
            `(document.querySelector(${JSON.stringify(FOLD_CONTROL)}).click(), null)`,
          );
          const foldOff = await readHandoffRecord(app);
          note("at0562 fold, motion off", foldOff);
          expect(foldOff.frames, "motion off: the fold reached its face").toBeLessThan(900);
          expect(foldOff.gapFrames, "motion off: fold shows a face on every frame").toBe(0);
          await app.evalJS<null>(`(window.__tug.setFirstResponder("A"), null)`);
          await armHandoffRecorder(
            app,
            `face === "behind" && sheet >= 0.98`,
          );
          await app.body("A").evalJS<null>(
            `(document.querySelector(${JSON.stringify(FOLD_CONTROL)}).click(), null)`,
          );
          const unfoldOff = await readHandoffRecord(app);
          note("at0562 unfold, motion off", unfoldOff);
          expect(unfoldOff.frames, "motion off: the unfold reached its face").toBeLessThan(900);
          expect(unfoldOff.identityKept).toBe(true);
          expect(unfoldOff.gapFrames, "motion off: unfold shows a face on every frame").toBe(0);
          expect(
            unfoldOff.faces,
            "motion off never leaves — it goes straight behind",
          ).not.toContain("leaving");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

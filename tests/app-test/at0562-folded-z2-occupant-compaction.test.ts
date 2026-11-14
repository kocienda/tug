/**
 * at0562-folded-z2-occupant-compaction.test.ts — a compaction on a folded card inhabits the Z2 row, raises no sheet, speaks the run's refusal there, and gives the cells back when it settles.
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
  CARD,
  OCCUPANT,
  OCCUPANT_ACTION,
  REFUSAL_TEXT,
  readRow,
  seed,
  sendWheelCompact,
} from "./folded-z2-occupant-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0562: a folded card's Z2 row carries its one occupant",
  () => {
    test(
      "a compaction on a folded card inhabits the row, raises no sheet, and gives the cells back",
      async () => {
        const app = await launchTugApp({ testName: "at0562-folded-compaction" });
        try {
          await seed(app);

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-card-fold"), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.__tug.getPaneRecord("p1").folded === true`,
            { timeoutMs: 8000 },
          );
          await new Promise((r) => setTimeout(r, 1200));

          const before = await readRow(app);
          note("at0562 folded, idle", before);
          expect(before.occupant).toBeNull();
          expect(before.cellsShown).toBe(before.cellsMounted);
          expect(before.cellsShown).toBeGreaterThan(0);

          await sendWheelCompact(app);
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OCCUPANT)}) !== null`,
            { timeoutMs: 8000 },
          );
          const running = await readRow(app);
          note("at0562 folded, compacting", running);

          expect(running.occupant).toBe("compaction");
          expect(running.text).toContain("Compacting");
          expect(
            running.hasBar,
            "the row carries the run's own barber pole",
          ).toBe(true);
          // The cover sheet on one line: the title is the sheet header's own
          // size (`--tugx-header-title-size`, 0.95rem) and the run's Cancel
          // rides the trailing edge, because while the card is folded this
          // row IS the run's surface — no cover rose to carry one.
          expect(running.titleSize, "the sheet's title size").toBe("15.2px");
          expect(running.text, "the run's Cancel rides the row").toContain(
            "Cancel",
          );
          // The sheet's colours, not the row's ([B01]): the bar wears the
          // `action` role the sheet's bar resolves to by default — the theme's
          // key blue — so its fill is a colour, never the `currentColor` an
          // `inherit` role paints in.
          expect(running.barRole, "the bar takes the sheet's role").toBe(
            "action",
          );
          expect(
            running.barFill,
            "and so paints in a colour of its own, not the row's prose",
          ).not.toBe("currentColor");
          expect(running.barFill).not.toBe("");
          // The centred group ([B03], [B04]): mark, title and bar are one
          // group in the middle of the row's full width, the bar at its fixed
          // 160px so the group has a width to centre on, and Cancel sits on
          // the trailing edge by itself.
          expect(running.barWidth, "the bar is the tuned fixed width").toBe(160);
          expect(
            running.groupOffCentre,
            "the mark-title-bar group is centred in the row",
          ).toBeLessThanOrEqual(1.5);
          expect(
            running.cancelOffEdge,
            "and Cancel is right-aligned",
          ).toBeLessThanOrEqual(1.5);
          // And the band does not change depth when it stops being the
          // instruments: the occupant holds the resting row's height. Read
          // unrounded: the 0.8px a rounded reading let through was the gap
          // that drew a second rule between Z2's bottom and the frame's.
          expect(
            Math.abs(running.stripHeight - before.stripHeight),
            "the strip is the same depth occupied or not",
          ).toBeLessThanOrEqual(0.1);
          // The instruments are hidden, not unmounted ([L26]).
          expect(running.cellsMounted).toBe(before.cellsMounted);
          expect(running.cellsShown).toBe(0);
          // No panel rose, and the fold stands.
          expect(running.sheets, "an inhabitant raises no sheet").toBe(0);
          expect(running.folded, "and does not open the fold").toBe(true);
          note("at0562 folded compaction row", (await app.screenshot()).path);

          // The refusal, spoken from the ROW ([B08]). A compacting card
          // refuses every door but the fold, and while it is folded there is
          // no cover to flash that refusal on — the panel the refusal line
          // lives under never rose. So the row takes the voice: the same
          // `data-refused` attribute and the same 3.2s, swapping its title
          // from what the run is doing to what it says to a refused door.
          //
          // The close ROUTE is the door pressed, for the reason `at0492`
          // presses it: it is where ⌘W, Close All and the Cards row's remote
          // close box all arrive, and the one with no on-screen control to
          // dim. Dispatched rather than chorded because a background app-test
          // cannot deliver a native menu key equivalent — the chord would be
          // swallowed and the assertion would pass without testing anything.
          //
          // Before this the folded case refused silently: the hold turned the
          // door away and nothing on screen moved, which reads as the app
          // ignoring the gesture.
          await app.dispatchControlAction("close");
          await new Promise((r) => setTimeout(r, 400));
          const refused = await readRow(app);
          note("at0562 folded, refused", refused);
          expect(
            // card-dom: shell — the card's one placeholder in the deck; its body holds two `data-card-id` nodes.
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(CARD)}).length`,
            ),
            "the card is still there — the close was refused, not performed",
          ).toBe(1);
          expect(refused.refused, "the row is flashing").toBe(true);
          expect(
            refused.text,
            "and says why, in the run's own words",
          ).toContain(REFUSAL_TEXT);
          // Narrowed for the two index reads below: `RowReading.text` is
          // nullable because the occupant may be absent, and the assertion
          // above has already established it is not.
          if (refused.text === null) throw new Error("unreachable");
          expect(
            refused.text.indexOf("Compacting"),
            "the running title yields its seat for the flash's length",
          ).toBe(refused.text.indexOf(REFUSAL_TEXT));
          expect(refused.folded, "and the fold still stands").toBe(true);

          // The flash returns the seat — a refusal is a beat, not a state. The
          // attribute stays (its animation is `forwards`), so what says the row
          // went back is what the user can SEE.
          //
          // Both halves of the swap are waited on, because the two readings
          // cross over rather than cut, and the refusal's `visibility` is what
          // says it is finished. Its opacity rounds to 0 a beat BEFORE the end
          // — `visibility` stays `visible` for the whole of a visible→hidden
          // ramp and flips only at the last frame — so waiting on the opacity,
          // or on the running title alone, lands in the middle of the
          // crossfade with both readings still in the row's visible text.
          await app.body("A").waitForCondition<boolean>(
            `(function(){
              var occ = document.querySelector(${JSON.stringify(OCCUPANT)});
              if (occ === null) return false;
              var running = occ.querySelector('[data-occupant-title="running"]');
              var refusal = occ.querySelector('[data-occupant-title="refused"]');
              if (running === null || refusal === null) return false;
              return getComputedStyle(running).visibility !== "hidden" &&
                getComputedStyle(refusal).visibility === "hidden";
            })()`,
            { timeoutMs: 8000 },
          );
          const restored = await readRow(app);
          note("at0562 folded, refusal over", restored);
          expect(restored.text, "the run's own reading is back").toContain(
            "Compacting",
          );
          expect(
            restored.text,
            "and the refusal has given the seat up",
          ).not.toContain(REFUSAL_TEXT);
          expect(
            restored.hasBar,
            "and the mark never left",
          ).toBe(true);

          // Settle the run by pressing the row's own Cancel — the run's one
          // cancel, registered on `compactionProgressStore` when it opened and
          // taken from there rather than rebuilt here, so this press and the
          // cover's are the same press. In stub mode no backend answers the
          // interrupt it sends; the store settles at the gesture, which is
          // what clears the occupant and gives the cells back.
          await app.body("A").evalJS<null>(
            `(document.querySelector(${JSON.stringify(OCCUPANT_ACTION)}).click(), null)`,
          );
          // The turn is then closed the way the wire would close it, so the
          // run's watcher reaches its own end as well.
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "turn_complete",
              seq: 0,
              tug_session_id: SID,
              msg_id: "at0562-compact",
              result: "interrupted",
            },
          });
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OCCUPANT)}) === null`,
            { timeoutMs: 12000 },
          );
          const after = await readRow(app);
          note("at0562 folded, settled", after);
          expect(after.occupant).toBeNull();
          expect(after.cellsShown, "the cells come back").toBe(
            before.cellsMounted,
          );
          expect(after.folded).toBe(true);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/**
 * at0569-sheet-reservation-measured.test.ts — a Session card added on the
 * production path bids the picker it measured, and the picker reports the
 * same number.
 *
 * The card arrives through `show-card`, so `addCard` measures the card's
 * opening form and bids what it read. That is where the first-report rule is
 * seen AGREEING — the number the deck holds for the member is the panel the
 * user is looking at, at two picker heights far enough apart that no constant
 * could have satisfied both ([P02], [P04], [P05]).
 *
 * Split from `at0569-sheet-reservation` to fit the 20 s file budget: the
 * three tests ran 17–18 s together when green, and at 19–20 s the third ran
 * out of file before its card's body stood ready. The reservation doctrine
 * this pins is that file's header; the shared constants and readers are
 * `sheet-reservation-fixture.ts`.
 *
 * @family at0569
 * @covers tugdeck/src/deck-store-selectors.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 * @covers tugdeck/src/lib/sheet-reservation.ts
 * @covers tugdeck/src/lib/opening-bid.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-registration.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { note } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import {
  pickerPanelNaturalHeight,
  pointPickerAt,
  removePickerSessions,
  seedPickerSessions,
  type PickerSessionsFixture,
} from "./picker-sessions-fixture";
import {
  MEASURED_BID_DRIFT,
  PICKER_FORM,
  REPORTER_DRIFT,
  SHEET_PANEL_TO_MEMBER_PX,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  bidMismatches,
  landed,
  launchOnQuietProject,
  pins,
  reservations,
} from "./sheet-reservation-fixture";

/** A project whose Sessions list stands at its cap, for the second reading. */
let fixture: PickerSessionsFixture | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  fixture = seedPickerSessions("at0569-measured");
});

afterAll(() => {
  removePickerSessions(fixture);
});

describe.skipIf(!SHOULD_RUN)("AT0569 — an unbound Session card stands at least at its picker's height", () => {
  test(
    "a card added on the production path bids what it measured, and the picker reports the same number",
    async () => {
      // The quiet project matters most here: this test needs the picker's
      // first form to be the short one.
      const { app, tugbankPath } = await launchOnQuietProject("at0569-measured-bid");
      try {
        // No Session card and no seeded bid in this fixture: the card arrives
        // through `addCard`, which is the only thing that MEASURES one. Slot 0
        // is a split column holding a single `hello` card, so the newcomer
        // joins it as a second member rather than stacking.
        await app.seedDeckState({
          state: {
            cards: [
              { id: "A", componentId: "hello", title: "Card A", closable: true },
              { id: "C", componentId: "hello", title: "Card C", closable: true },
            ],
            panes: [
              {
                id: "p1",
                position: { x: 40, y: 40 },
                size: { width: 600, height: 400 },
                cardIds: ["A"],
                activeCardId: "A",
                title: "",
                acceptsFamilies: ["maker"],
                slot: 0,
              },
              {
                id: "p3",
                position: { x: 40, y: 40 },
                size: { width: 600, height: 400 },
                cardIds: ["C"],
                activeCardId: "C",
                title: "",
                acceptsFamilies: ["maker"],
                slot: 1,
              },
            ],
            activePaneId: "p1",
            imposition: {
              kind: "two-up",
              sidebars: {},
              columns: { 0: { mode: "split", order: ["p1"] } },
            },
            hasFocus: true,
          },
          focusCardId: "A",
        });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p3"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await landed(app);

        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("show-card", { component: "session" }), null)`,
        );
        // The picker is in the new Session card's body — the deck's only one.
        await kindBody(app, "session").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await landed(app);

        const newcomer = await app.evalJS<string | null>(
          `(function () {
            var seeded = ["p1", "p3"];
            var frames = document.querySelectorAll(".tug-pane[data-pane-id]");
            for (var i = 0; i < frames.length; i += 1) {
              var id = frames[i].getAttribute("data-pane-id");
              if (seeded.indexOf(id) === -1) return id;
            }
            return null;
          })()`,
        );
        expect(newcomer, "the card arrived").not.toBeNull();

        // ── ONE ROW. A fresh instance's `sessions.db` is empty, so the picker
        //    the card raises lists a single "New session" row and its panel is
        //    the short one. The number the deck holds for the member is what
        //    the app measured off that panel before it committed the pane, and
        //    the panel the user is now looking at reports the same number
        //    through the same arithmetic ([P02], [P04]). ──
        const oneRowPanel = await pickerPanelNaturalHeight(kindBody(app, "session"));
        const oneRowHeld =
          (await reservations(app))?.[newcomer ?? ""] ??
          (await pins(app))?.[newcomer ?? ""] ??
          -1;
        note(
          `one-row picker: panel natural ${(oneRowPanel ?? -1).toFixed(1)}px, the deck holds ${oneRowHeld.toFixed(1)}px for the member`,
        );
        expect(oneRowPanel, "the picker's panel is on screen").not.toBeNull();
        expect(
          Math.abs(oneRowHeld - ((oneRowPanel ?? -1) + SHEET_PANEL_TO_MEMBER_PX)),
          "the first live report is the bid — the number the app measured before the commit",
        ).toBeLessThanOrEqual(MEASURED_BID_DRIFT);
        expect(
          await bidMismatches(app),
          "and the deck recorded no disagreement, because there was none",
        ).toEqual([]);

        // ── AT THE CAP. Filling the list is a genuine change to the picker,
        //    so the report it provokes is an honest update rather than a
        //    contradiction ([P05]). The member's number follows it, and the
        //    two heights are far enough apart that no single constant could
        //    have been right at both — which is the whole case for measuring.
        //    ──
        if (fixture === null) {
          throw new Error("the picker sessions fixture was not seeded");
        }
        await pointPickerAt(kindBody(app, "session"), fixture);
        await landed(app);
        const cappedPanel = await pickerPanelNaturalHeight(kindBody(app, "session"));
        const cappedHeld = (await reservations(app))?.[newcomer ?? ""] ?? -1;
        note(
          `list at its cap: panel natural ${(cappedPanel ?? -1).toFixed(1)}px, the deck holds ${cappedHeld.toFixed(1)}px for the member`,
        );
        expect(
          Math.abs(cappedHeld - ((cappedPanel ?? -1) + SHEET_PANEL_TO_MEMBER_PX)),
          "the claim follows the picker that changed under it",
        ).toBeLessThanOrEqual(REPORTER_DRIFT);
        expect(
          cappedHeld - oneRowHeld,
          "and the two pickers are far enough apart that no constant fits both",
        ).toBeGreaterThan(100);
        expect(
          await bidMismatches(app),
          "an honest update is not a mismatch",
        ).toEqual([]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

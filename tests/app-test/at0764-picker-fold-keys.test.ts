/**
 * at0764-picker-fold-keys.test.ts — in the Choose Session sheet, ⌘← folds the
 * selection's project and ⌘→ unfolds it.
 *
 * ## What this gates
 *
 * The picker groups its sessions under one band per project, and a band folds
 * on a click or on Return while it is the selection. ⌘← and ⌘→ are the
 * Finder-list pair for the same act, and they work from ANY row of a group,
 * not only from its band: folding from inside hides the selected row, so the
 * selection and the list's cursor move up onto the band, where the next ⌘→
 * finds the project again.
 *
 * A fresh instance's picker lists one project, opened, with its cursor on
 * "New session" — which is exactly the inside-the-group case. So the reading
 * is the band's own `data-expanded` and `data-selected` after each chord:
 *
 *   - ⌘← from "New session": the band folds and becomes the selection. Fails
 *     if the chord never reaches the list, or if the selection snaps back to
 *     a row the fold hid instead of landing on the band.
 *   - ⌘→ from the band: the band unfolds and stays the selection.
 *   - ⌘← again from the band: it folds without moving anywhere.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-picker-form.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const PICKER_OPEN = 'document.querySelector(".session-card-picker-form") !== null';

/** The first band's fold state and whether it is the selection. */
const BAND_STATE = `(function () {
  var band = document.querySelector('[data-testid="session-card-picker-group"]');
  if (band === null) return null;
  return {
    expanded: band.getAttribute("data-expanded"),
    selected: band.getAttribute("data-selected") === "true",
    newRows: document.querySelectorAll('[data-testid="session-card-picker-session-new"]').length,
  };
})()`;

interface BandState {
  expanded: string | null;
  selected: boolean;
  newRows: number;
}

async function seedPickerCard(app: App): Promise<void> {
  await app.seedDeckState({
    state: {
      cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
      panes: [
        {
          id: "p1",
          position: { x: 40, y: 40 },
          size: { width: 860, height: 640 },
          cardIds: ["A"],
          activeCardId: "A",
          title: "",
          acceptsFamilies: ["maker"],
        },
      ],
      activePaneId: "p1",
      hasFocus: true,
    },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  await app.body("A").waitForCondition<boolean>(PICKER_OPEN, { timeoutMs: 8000 });
}

/** Wait until the first band reads `expanded`, and return what it reads. */
async function bandBecomes(app: App, expanded: "true" | "false"): Promise<BandState> {
  await app.body("A").waitForCondition<boolean>(
    `(function () { var s = ${BAND_STATE}; return s !== null && s.expanded === "${expanded}"; })()`,
    { timeoutMs: 4000 },
  );
  return (await app.body("A").evalJS<BandState | null>(BAND_STATE)) as BandState;
}

describe.skipIf(!SHOULD_RUN)("at0764 — ⌘← and ⌘→ fold and unfold a picker project", () => {
  test(
    "⌘← folds from inside the group onto its band; ⌘→ unfolds it",
    async () => {
      const app = await launchTugApp({ testName: "at0764-picker-fold-keys" });
      try {
        await seedPickerCard(app);
        // The default cursor is the open group's New session row.
        const atRest = await bandBecomes(app, "true");
        note(`at0764 at rest: ${JSON.stringify(atRest)}`);
        expect(atRest.selected, "at rest the selection is New session, not the band").toBe(
          false,
        );

        await app.nativeKey("ArrowLeft", ["cmd"]);
        const folded = await bandBecomes(app, "false");
        note(`at0764 after ⌘←: ${JSON.stringify(folded)}`);
        expect(folded.newRows, "the folded group shows no New session row").toBe(0);
        expect(
          folded.selected,
          "folding from New session moves the selection onto the band",
        ).toBe(true);

        await app.nativeKey("ArrowRight", ["cmd"]);
        const unfolded = await bandBecomes(app, "true");
        note(`at0764 after ⌘→: ${JSON.stringify(unfolded)}`);
        expect(unfolded.selected, "⌘→ leaves the selection on the band").toBe(true);

        await app.nativeKey("ArrowLeft", ["cmd"]);
        const refolded = await bandBecomes(app, "false");
        expect(refolded.selected, "⌘← from the band folds it in place").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

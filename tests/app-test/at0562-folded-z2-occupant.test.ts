/**
 * at0562-folded-z2-occupant.test.ts — a folded card says what it is doing in
 * its Z2 row, in place of the five telemetry cells.
 *
 * ## Why this exists
 *
 * A folded Session card is its masthead and its Z2 row and nothing else, so a
 * surface that arrives while it is folded has one row to work with. A
 * compaction is the one surface small enough to BE that row: it declares
 * `foldPresentation: "inhabit"` on its `showSheet`, which on a folded card
 * raises no panel and leaves the fold standing, and the row reads
 * "Compacting…" with its wave instead of the instruments. When the run
 * settles, the cells come back.
 *
 * The vehicle is the frame tugcast puts on the wire for a `/compact` the WHEEL
 * sent — `origin: "wheel"`, opening its turn inside the store without passing
 * the composer. A folded card's composer is folded away, so the typed path is
 * not available to a test that folds first, and the wheel's path is the one
 * that most needs the cover anyway: nobody typed it.
 *
 * The same run on an OPEN card still raises its pane-modal sheet, which is
 * `at0492-compaction-card-modality`'s subject; the second case here only pins
 * that the row stays out of it.
 *
 * The third case is the other tier. A permission request is an inline dialog
 * the TRANSCRIPT carries, and a folded card is not showing its transcript — so
 * an arrival that said nothing in Z2 would be one the user never learns about.
 * It gets the `defer` notice instead ([B03]/[B05]): the dialog's own mark, a
 * title, and **Unfold**. Pressing it opens the card and nothing else, because
 * the dialog was mounted the whole time; the notice never dismisses itself,
 * which is what the fold-and-look-again beat at the end reads.
 *
 * @covers tugdeck/src/components/tugways/cards/session-compaction-run.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.css
 * @covers tugdeck/src/lib/card-fold.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0562-session";
const CODE_OUTPUT_FEED = 0x40;

const CARD = '[data-card-id="A"]';
const ROW = `${CARD} [data-slot="session-telemetry-status-row"]`;
const OCCUPANT = `${CARD} [data-slot="session-telemetry-status-occupant"]`;
const CELL = `${CARD} [data-slot="tug-status-cell"]`;
const SHEET = '[data-slot="tug-sheet"]';
const UNFOLD = `${CARD} .session-telemetry-occupant-action`;
const DIALOG = `${CARD} [data-slot="session-permission-dialog"]`;

interface RowReading {
  /** The row's declared occupant, or `null` for the instruments. */
  occupant: string | null;
  /** The occupant's text, trimmed. */
  text: string | null;
  /** How many cells are laid out (a hidden cell is still mounted). */
  cellsMounted: number;
  cellsShown: number;
  /** Whether the wave mark is up. */
  hasWave: boolean;
  sheets: number;
  folded: boolean;
}

const READ_ROW = `(function(){
  var row = document.querySelector(${JSON.stringify(ROW)});
  var occ = document.querySelector(${JSON.stringify(OCCUPANT)});
  var cells = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}));
  var frame = document.querySelector('.tug-pane[data-pane-id="p1"]');
  return {
    occupant: row === null ? null : row.getAttribute("data-occupant"),
    text: occ === null ? null : (occ.textContent || "").trim(),
    cellsMounted: cells.length,
    cellsShown: cells.filter(function (c) {
      return getComputedStyle(c).display !== "none";
    }).length,
    hasWave:
      occ !== null && occ.querySelector('[data-variant="wave"]') !== null,
    sheets: document.querySelectorAll(${JSON.stringify(SHEET)}).length,
    folded: frame.getAttribute("data-folded") === "true",
  };
})()`;

function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

async function seed(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

/** The frame tugcast announces a wheel-sent `/compact` with. */
async function sendWheelCompact(app: App): Promise<void> {
  await app.driveSession("A", {
    op: "ingestFrame",
    feedId: CODE_OUTPUT_FEED,
    decoded: {
      type: "tug_notice",
      tug_session_id: SID,
      origin: "wheel",
      text: "/compact",
    },
  });
}

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
            `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.__tug.getPaneRecord("p1").folded === true`,
            { timeoutMs: 8000 },
          );
          await new Promise((r) => setTimeout(r, 1200));

          const before = await app.evalJS<RowReading>(READ_ROW);
          note("at0562 folded, idle", before);
          expect(before.occupant).toBeNull();
          expect(before.cellsShown).toBe(before.cellsMounted);
          expect(before.cellsShown).toBeGreaterThan(0);

          await sendWheelCompact(app);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OCCUPANT)}) !== null`,
            { timeoutMs: 8000 },
          );
          const running = await app.evalJS<RowReading>(READ_ROW);
          note("at0562 folded, compacting", running);

          expect(running.occupant).toBe("compaction");
          expect(running.text).toContain("Compacting");
          expect(running.hasWave, "the row carries the run's wave").toBe(true);
          // The instruments are hidden, not unmounted ([L26]).
          expect(running.cellsMounted).toBe(before.cellsMounted);
          expect(running.cellsShown).toBe(0);
          // No panel rose, and the fold stands.
          expect(running.sheets, "an inhabitant raises no sheet").toBe(0);
          expect(running.folded, "and does not open the fold").toBe(true);
          note("at0562 folded compaction row", (await app.screenshot()).path);

          // Settle the run. A folded card has no Cancel button to press, and
          // in stub mode no backend answers the interrupt — so the turn is
          // closed the way the wire would close it. The run is watched off the
          // store rather than off any surface, so it settles from here exactly
          // as it would with the sheet up: no compaction ink arrived, so the
          // card reports the refusal and clears.
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "turn_complete",
              tug_session_id: SID,
              msg_id: "at0562-compact",
              result: "interrupted",
            },
          });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OCCUPANT)}) === null`,
            { timeoutMs: 12000 },
          );
          const after = await app.evalJS<RowReading>(READ_ROW);
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

    test(
      "the same compaction on an OPEN card raises its cover, and its hold refuses the fold",
      async () => {
        const app = await launchTugApp({ testName: "at0562-open-compaction" });
        try {
          await seed(app);
          await sendWheelCompact(app);
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-slot="compaction-progress"]') !== null`,
            { timeoutMs: 8000 },
          );
          const open = await app.evalJS<RowReading>(READ_ROW);
          note("at0562 open, compacting", open);
          expect(open.sheets).toBe(1);
          expect(open.occupant).toBeNull();
          expect(open.cellsShown).toBe(open.cellsMounted);

          // Folding under the cover is REFUSED, and that is the hold speaking
          // rather than the fold rule. A run takes `cardModalHoldStore` for as
          // long as it needs the card, and every door that finds one stops and
          // lets the holder say why ([L31]) — the fold is one of those doors.
          // So the one sheet that could have outlived a fold never meets one:
          // an ordinary sheet is stood down by the fold (`at0558` reads that),
          // and a run's cover refuses it outright.
          //
          // The card is made first responder first, so the gesture is REFUSED
          // rather than merely undelivered: a cover autofocuses its own panel,
          // and a fold that never reached the card's handler would read here
          // exactly like one the hold turned away.
          await app.evalJS<null>(`(window.__tug.setFirstResponder("A"), null)`);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
          );
          await new Promise((r) => setTimeout(r, 1200));
          const held = await app.evalJS<RowReading>(READ_ROW);
          note("at0562 fold attempted under a live cover", held);
          expect(held.folded, "the run holds the card open").toBe(false);
          expect(held.sheets, "and its cover stands").toBe(1);
          expect(held.occupant, "so the row is still the instruments'").toBeNull();
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

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
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
            { timeoutMs: 8000 },
          );

          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.__tug.getPaneRecord("p1").folded === true`,
            { timeoutMs: 8000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OCCUPANT)}) !== null`,
            { timeoutMs: 8000 },
          );

          const notice = await app.evalJS<RowReading>(READ_ROW);
          note("at0562 folded, permission pending", notice);
          expect(notice.occupant).toBe("permission");
          expect(notice.text).toContain("Permission");
          expect(notice.text, "the Unfold action rides the notice").toContain(
            "Unfold",
          );
          expect(notice.hasWave, "a notice is not a run").toBe(false);
          expect(notice.cellsMounted).toBeGreaterThan(0);
          expect(notice.cellsShown, "the instruments stand down").toBe(0);
          expect(notice.sheets, "a deferred arrival raises no panel").toBe(0);
          expect(notice.folded, "and does not open the fold itself").toBe(true);
          note("at0562 folded defer notice", (await app.screenshot()).path);

          // The press is the whole of the interaction: the card opens and the
          // dialog that was mounted all along is simply on show again.
          await app.evalJS<null>(
            `(document.querySelector(${JSON.stringify(UNFOLD)}).click(), null)`,
          );
          await app.waitForCondition<boolean>(
            `window.__tug.getPaneRecord("p1").folded === false`,
            { timeoutMs: 8000 },
          );
          const opened = await app.evalJS<RowReading>(READ_ROW);
          note("at0562 unfolded by the notice", opened);
          expect(opened.occupant, "the row is the instruments' again").toBeNull();
          expect(opened.cellsShown).toBe(opened.cellsMounted);
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(DIALOG)}) !== null`,
            ),
            "the request is still pending, now visible",
          ).toBe(true);

          // Nothing was answered, so folding again brings the notice straight
          // back — it tracks the pending state and holds no dismissal of its
          // own.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OCCUPANT)}) !== null`,
            { timeoutMs: 8000 },
          );
          const again = await app.evalJS<RowReading>(READ_ROW);
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

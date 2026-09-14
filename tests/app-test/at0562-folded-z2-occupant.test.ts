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
 * "Compacting…" with its barber pole instead of the instruments — in the one-row
 * inline dialog's own voice (the dialog's 14px title, the run's bar beside it,
 * an action on the trailing edge), because that dialog is what the transcript
 * carries for the same kind of news and the two should read as one family. The
 * action is the
 * run's own Cancel, taken off `compactionProgressStore`: no cover rose, so
 * this row is where the run offers its one way out. When the run settles, the
 * cells come back, and the strip is the same depth throughout.
 *
 * The vehicle is the frame tugcast puts on the wire for a `/compact` the WHEEL
 * sent — `origin: "wheel"`, opening its turn inside the store without passing
 * the composer. A folded card's composer is folded away, so the typed path is
 * not available to a test that folds first, and the wheel's path is the one
 * that most needs the cover anyway: nobody typed it.
 *
 * The row is also the run's VOICE while the card is folded. A compacting card
 * refuses every door but the fold, and with no cover up there is no refusal
 * line to flash — so the row takes it, swapping its title from what the run is
 * doing to what it says to a refused door for the flash's length and then
 * giving the seat back ([B08]). The first case presses the close route and
 * reads both halves.
 *
 * The same run on an OPEN card still raises its pane-modal sheet, which is
 * `at0492-compaction-card-modality`'s subject; the second case here only pins
 * that the row stays out of it, and that the fold passes through the run's
 * hold into this row.
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
 * @covers tugdeck/src/lib/compaction-progress-store.ts
 * @covers tugdeck/src/lib/card-fold.ts
 * @covers tugdeck/src/lib/card-modal-hold-store.ts
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
/** The occupant's one action — **Cancel** on a compaction, **Unfold** on an
    arrival's notice. One class, because it is one seat in one row. */
const OCCUPANT_ACTION = `${CARD} .session-telemetry-occupant-action`;
const DIALOG = `${CARD} [data-slot="session-permission-dialog"]`;
/** What the run says to a refused door — `COMPACTION_REFUSAL_TEXT`, copied
    rather than imported because this file drives the built app rather than
    linking against its source. */
const REFUSAL_TEXT = "Compacting — press Cancel to stop";

interface RowReading {
  /** The row's declared occupant, or `null` for the instruments. */
  occupant: string | null;
  /** The occupant's text, trimmed. */
  text: string | null;
  /** How many cells are laid out (a hidden cell is still mounted). */
  cellsMounted: number;
  cellsShown: number;
  /** Whether the run's own barber pole is up. */
  hasBar: boolean;
  /** Whether the occupant is mid-refusal ([B08]). */
  refused: boolean;
  /** The strip's own height — the same depth occupied or not ([B04]). */
  stripHeight: number;
  /** The occupant's title face, so the dialog family is pinned, not assumed. */
  titleSize: string | null;
  sheets: number;
  folded: boolean;
}

const READ_ROW = `(function(){
  // The occupant's VISIBLE text, which textContent is not: the compaction
  // occupant's title seat holds two readings, its running one and its refusal,
  // and swaps between them in CSS ([B08]), so textContent returns both at once
  // and says nothing about which the user can see. innerText would answer the
  // question but also applies text-transform, so the row's Cancel would come
  // back shouting. This walks the tree and skips what is hidden, which is
  // exactly the difference and nothing else. (No backticks below — this whole
  // block is a template literal.)
  function visibleText(node) {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (getComputedStyle(node).visibility === "hidden") return "";
    var out = "";
    node.childNodes.forEach(function (child) { out += visibleText(child); });
    return out;
  }
  var row = document.querySelector(${JSON.stringify(ROW)});
  var occ = document.querySelector(${JSON.stringify(OCCUPANT)});
  var cells = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}));
  var frame = document.querySelector('.tug-pane[data-pane-id="p1"]');
  var strip = document.querySelector(${JSON.stringify(
    `${CARD} [data-slot="session-card-status-bar"]`,
  )});
  var title = occ === null
    ? null
    : occ.querySelector(".session-telemetry-occupant-title");
  return {
    occupant: row === null ? null : row.getAttribute("data-occupant"),
    text: occ === null ? null : visibleText(occ).trim(),
    cellsMounted: cells.length,
    cellsShown: cells.filter(function (c) {
      return getComputedStyle(c).display !== "none";
    }).length,
    hasBar:
      occ !== null && occ.querySelector('[data-variant="bar"]') !== null,
    refused: occ !== null && occ.hasAttribute("data-refused"),
    stripHeight: strip === null
      ? 0
      : Math.round(strip.getBoundingClientRect().height),
    titleSize: title === null ? null : getComputedStyle(title).fontSize,
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
          // And the band does not change depth when it stops being the
          // instruments: the occupant holds the resting row's height.
          expect(
            Math.abs(running.stripHeight - before.stripHeight),
            "the strip is the same depth occupied or not",
          ).toBeLessThanOrEqual(1);
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
          const refused = await app.evalJS<RowReading>(READ_ROW);
          note("at0562 folded, refused", refused);
          expect(
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
          await app.waitForCondition<boolean>(
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
          const restored = await app.evalJS<RowReading>(READ_ROW);
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
          await app.evalJS<null>(
            `(document.querySelector(${JSON.stringify(OCCUPANT_ACTION)}).click(), null)`,
          );
          // The turn is then closed the way the wire would close it, so the
          // run's watcher reaches its own end as well.
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
      "the same compaction on an OPEN card raises its cover, and its hold admits the fold",
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
          await app.evalJS<null>(`(window.__tug.setFirstResponder("A"), null)`);
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("toggle-session-fold"), null)`,
          );
          await new Promise((r) => setTimeout(r, 1200));
          const held = await app.evalJS<RowReading>(READ_ROW);
          note("at0562 fold under a live cover", held);
          expect(held.folded, "the hold admits the fold").toBe(true);
          expect(
            held.occupant,
            "and the row takes the run's other face",
          ).toBe("compaction");
          expect(held.text, "which reads the run and offers its Cancel").toContain(
            "Compacting",
          );
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
          expect(notice.hasBar, "a notice is not a run").toBe(false);
          expect(notice.cellsMounted).toBeGreaterThan(0);
          expect(notice.cellsShown, "the instruments stand down").toBe(0);
          expect(notice.sheets, "a deferred arrival raises no panel").toBe(0);
          expect(notice.folded, "and does not open the fold itself").toBe(true);
          note("at0562 folded defer notice", (await app.screenshot()).path);

          // The press is the whole of the interaction: the card opens and the
          // dialog that was mounted all along is simply on show again.
          await app.evalJS<null>(
            `(document.querySelector(${JSON.stringify(OCCUPANT_ACTION)}).click(), null)`,
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

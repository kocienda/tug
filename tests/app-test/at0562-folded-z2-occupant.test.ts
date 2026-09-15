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
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
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
/** The card's one fold control, in the Z2 strip — a BUTTON, which is the point
    of the second case's fold: a fold performed by clicking it leaves the key
    view on that button, and the row's Cancel has to take it back ([B02]). */
const FOLD_CONTROL = `${CARD} [data-slot="session-fold-control"] button`;
const DIALOG = `${CARD} [data-slot="session-permission-dialog"]`;
/** What the run says to a refused door — `COMPACTION_REFUSAL_TEXT`, copied
    rather than imported because this file drives the built app rather than
    linking against its source. */
const REFUSAL_TEXT = "Compacting — press Cancel to stop";

interface RowReading {
  /** The row's declared occupant, or `null` for the instruments. */
  occupant: string | null;
  /** Which face of a compaction the row wears — `showing`, `leaving`, or
      `behind` the cover — or `null` when no run is in flight ([B05]). */
  face: string | null;
  /** Whether the occupant element is laid out (`display` other than `none`). */
  occupantShown: boolean;
  /** The occupant's text, trimmed. */
  text: string | null;
  /** How many cells are laid out (a hidden cell is still mounted). */
  cellsMounted: number;
  cellsShown: number;
  /** Whether the run's own barber pole is up. */
  hasBar: boolean;
  /** The bar's role, as the indicator stamps it — `action` is the sheet's
      key blue; `inherit` was the row's prose colour ([B01]). */
  barRole: string | null;
  /** The bar's fill custom property, resolved. `currentColor` is the wrong
      answer; a colour is the right one. */
  barFill: string | null;
  /** The bar seat's laid-out width — fixed by `--tugx-z2-occupant-bar-width`
      ([B04]), so the group has a width to centre on. */
  barWidth: number;
  /** How far the mark-title-bar group's centre sits from the occupant's own
      centre, in px ([B03]). Zero is centred. */
  groupOffCentre: number;
  /** How far Cancel's trailing edge sits from the occupant's padding edge,
      in px ([B03]). Zero is right-aligned. */
  cancelOffEdge: number;
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
  var bar = occ === null ? null : occ.querySelector('[data-variant="bar"]');
  var barSeat = occ === null
    ? null
    : occ.querySelector(".session-telemetry-occupant-bar");
  var group = occ === null
    ? null
    : occ.querySelector('[data-slot="session-telemetry-occupant-group"]');
  var cancel = occ === null
    ? null
    : occ.querySelector(".session-telemetry-occupant-action");
  var groupOffCentre = 0;
  var cancelOffEdge = 0;
  if (occ !== null && group !== null && cancel !== null) {
    var o = occ.getBoundingClientRect();
    var g = group.getBoundingClientRect();
    var c = cancel.getBoundingClientRect();
    var padRight = parseFloat(getComputedStyle(occ).paddingRight) || 0;
    groupOffCentre = Math.abs((g.left + g.right) / 2 - (o.left + o.right) / 2);
    cancelOffEdge = Math.abs((o.right - padRight) - c.right);
  }
  return {
    occupant: row === null ? null : row.getAttribute("data-occupant"),
    face: row === null ? null : row.getAttribute("data-face"),
    occupantShown:
      occ !== null && getComputedStyle(occ).display !== "none",
    text: occ === null ? null : visibleText(occ).trim(),
    cellsMounted: cells.length,
    cellsShown: cells.filter(function (c) {
      return getComputedStyle(c).display !== "none";
    }).length,
    hasBar:
      occ !== null && occ.querySelector('[data-variant="bar"]') !== null,
    barRole: bar === null ? null : bar.getAttribute("data-role"),
    barFill: bar === null
      ? null
      : getComputedStyle(bar)
          .getPropertyValue("--tugx-progress-indicator-fill")
          .trim(),
    barWidth: barSeat === null
      ? 0
      : Math.round(barSeat.getBoundingClientRect().width),
    groupOffCentre: groupOffCentre,
    cancelOffEdge: cancelOffEdge,
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

/** What the handoff recorder writes, one entry per animation frame. */
interface HandoffRecord {
  /** The occupant is the same element on every frame it was present. */
  identityKept: boolean;
  /** Frames inside the crossing (or while `leaving`) that laid the cells out. */
  cellFramesInCrossing: number;
  /** Frames on which NEITHER face was visible — the gap [F05] describes. */
  gapFrames: number;
  /** Frames on which BOTH faces were visible — the handoff itself. */
  overlapFrames: number;
  frames: number;
  faces: (string | null)[];
  done: boolean;
}

/**
 * Arm a per-frame recorder for a fold or unfold of a compacting card
 * ([B05]–[B07]). It reads, every animation frame: which element the occupant
 * is, the row's `data-face`, whether the cells are laid out, and the VISIBLE
 * opacity of each face — the occupant's (zero while `display: none`) and the
 * cover's (zero while no panel is mounted). A frame with neither face above
 * a hair of opacity is a gap; a frame with both is the overlap the handoff is
 * made of. `stopWhen` is a JS expression over `face`, `crossing`, `occ`
 * (opacity) and `sheet` (opacity) that ends the recording.
 */
async function armHandoffRecorder(app: App, stopWhen: string): Promise<void> {
  await app.evalJS<null>(
    `(function(){
      var occSel = ${JSON.stringify(OCCUPANT)};
      var cellSel = ${JSON.stringify(CELL)};
      var rowSel = ${JSON.stringify(ROW)};
      var sheetSel = ${JSON.stringify(SHEET)};
      var occ0 = document.querySelector(occSel);
      var frame = document.querySelector('.tug-pane[data-pane-id="p1"]');
      var rec = {
        identityKept: true,
        cellFramesInCrossing: 0,
        gapFrames: 0,
        overlapFrames: 0,
        frames: 0,
        faces: [],
        done: false,
      };
      function visibleOpacity(el) {
        if (el === null) return 0;
        var cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return 0;
        return parseFloat(cs.opacity);
      }
      function tick() {
        rec.frames += 1;
        var occEl = document.querySelector(occSel);
        if (occEl !== null && occ0 !== null && occEl !== occ0) rec.identityKept = false;
        var row = document.querySelector(rowSel);
        var face = row === null ? null : row.getAttribute("data-face");
        if (rec.faces[rec.faces.length - 1] !== face) rec.faces.push(face);
        var crossing = frame.hasAttribute("data-fold-crossing");
        var shown = Array.prototype.filter.call(
          document.querySelectorAll(cellSel),
          function (c) { return getComputedStyle(c).display !== "none"; }
        ).length;
        if ((crossing || face === "leaving") && shown > 0) {
          rec.cellFramesInCrossing += 1;
        }
        var occ = visibleOpacity(occEl);
        var sheet = visibleOpacity(document.querySelector(sheetSel));
        if (occ < 0.05 && sheet < 0.05) rec.gapFrames += 1;
        if (occ >= 0.05 && sheet >= 0.05) rec.overlapFrames += 1;
        if (rec.frames > 3 && (${stopWhen})) { rec.done = true; return; }
        if (rec.frames > 900) { rec.done = true; return; }
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      window.__at0562rec = rec;
      return null;
    })()`,
  );
}

async function readHandoffRecord(app: App): Promise<HandoffRecord> {
  await app.waitForCondition<boolean>(`window.__at0562rec.done === true`, {
    timeoutMs: 15000,
  });
  return app.evalJS<HandoffRecord>(`window.__at0562rec`);
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
          await app.evalJS<null>(
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
          const readRing = () => app.evalJS<{
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
          await app.waitForCondition<boolean>(
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
          await app.evalJS<null>(
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
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHEET)}).length === 1`,
            { timeoutMs: 8000 },
          );
          const reopened = await app.evalJS<RowReading>(READ_ROW);
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
          await app.evalJS<null>(`(window.__tug.setFirstResponder("A"), null)`);
          await armHandoffRecorder(
            app,
            `face === "showing" && occ >= 0.98 && sheet === 0`,
          );
          await app.evalJS<null>(
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
          await app.evalJS<null>(
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

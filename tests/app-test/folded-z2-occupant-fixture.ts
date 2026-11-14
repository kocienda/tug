/**
 * folded-z2-occupant-fixture.ts — the shared seed, row reader and handoff
 * recorder the at0562-folded-z2-occupant-* files read a Session card's Z2 row
 * through.
 *
 * A folded card says what it is doing in its Z2 row, in place of the five
 * telemetry cells.
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
 * giving the seat back ([B08]). The compaction file presses the close route and
 * reads both halves.
 *
 * The same run on an OPEN card still raises its pane-modal sheet, which is
 * `at0492-compaction-card-modality`'s subject; the open-compaction file only pins
 * that the row stays out of it, and that the fold passes through the run's
 * hold into this row.
 *
 * The defer file is the other tier. A permission request is an inline dialog
 * the TRANSCRIPT carries, and a folded card is not showing its transcript — so
 * an arrival that said nothing in Z2 would be one the user never learns about.
 * It gets the `defer` notice instead ([B03]/[B05]): the dialog's own mark, a
 * title, and **Unfold**. Pressing it opens the card and nothing else, because
 * the dialog was mounted the whole time; the notice never dismisses itself,
 * which is what the fold-and-look-again beat at the end reads.
 *
 * @module tests/app-test/folded-z2-occupant-fixture
 */

import { note, type App } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_COMPACT } from "./_harness/shapes";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

export const SID = "at0562-session";
export const CODE_OUTPUT_FEED = 0x40;

export const CARD = '[data-card-id="A"]';
export const ROW = `${CARD} [data-slot="session-telemetry-status-row"]`;
export const OCCUPANT = `${CARD} [data-slot="session-telemetry-status-occupant"]`;
export const CELL = `${CARD} [data-slot="tug-status-cell"]`;
export const SHEET = '[data-slot="tug-sheet"]';
/** The occupant's one action — **Cancel** on a compaction, **Unfold** on an
    arrival's notice. One class, because it is one seat in one row. */
export const OCCUPANT_ACTION = `${CARD} .session-telemetry-occupant-action`;
/** The card's one fold control, in the Z2 strip — a BUTTON, which is the point
    of the open-compaction file's fold: a fold performed by clicking it leaves the key
    view on that button, and the row's Cancel has to take it back ([B02]). */
export const FOLD_CONTROL = `${CARD} [data-slot="session-fold-control"] button`;
export const DIALOG = `${CARD} [data-slot="session-permission-dialog"]`;
/** What the run says to a refused door — `COMPACTION_REFUSAL_TEXT`, copied
    rather than imported because these files drive the built app rather than
    linking against its source. */
export const REFUSAL_TEXT = "Compacting — press Cancel to stop";

export interface RowReading {
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

export const READ_ROW = `(function(){
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
    barRole: bar === null ? null : bar.getAttribute("data-tone"),
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
      : strip.getBoundingClientRect().height,
    titleSize: title === null ? null : getComputedStyle(title).fontSize,
    sheets: document.querySelectorAll(${JSON.stringify(SHEET)}).length,
  };
})()`;

/**
 * {@link READ_ROW} in A's body — the row, its cells and the card's sheets are
 * the card's DOM — beside the fold flag, which is the pane frame's
 * `data-folded` and so the shell's.
 */
export async function readRow(app: App): Promise<RowReading> {
  const row = await app.body("A").evalJS<Omit<RowReading, "folded">>(READ_ROW);
  // card-dom: shell — the fold flag is the pane frame's, drawn by the shell.
  const folded = await app.evalJS<boolean>(
    `document.querySelector('.tug-pane[data-pane-id="p1"]').getAttribute("data-folded") === "true"`,
  );
  return { ...row, folded };
}

// Kept local: every file's `seed` builds its own deck and waits on its own
// readiness, so the name is shared and the function is not.
export async function seed(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

/** The frame tugcast announces a wheel-sent `/compact` with. */
export async function sendWheelCompact(app: App): Promise<void> {
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
export interface HandoffRecord {
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
export async function armHandoffRecorder(app: App, stopWhen: string): Promise<void> {
  await app.body("A").evalJS<null>(
    `(function(){
      var occSel = ${JSON.stringify(OCCUPANT)};
      var cellSel = ${JSON.stringify(CELL)};
      var rowSel = ${JSON.stringify(ROW)};
      var sheetSel = ${JSON.stringify(SHEET)};
      var occ0 = document.querySelector(occSel);
      // The body's own frame, which carries the shell's fold crossing as a
      // mirror (applyCrossingMirror): the recorder runs in A's page. A whole
      // card draws its pane in its own page, so its frame is that page's
      // \`.tug-pane\`; \`.body-pane-frame\` is a content-only body's.
      var frame = document.querySelector(".tug-pane") || document.querySelector(".body-pane-frame");
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

export async function readHandoffRecord(app: App): Promise<HandoffRecord> {
  // The recorder was armed in A's body, so its record is that page's.
  try {
    await app.body("A").waitForCondition<boolean>(`window.__at0562rec.done === true`, {
      timeoutMs: 15000,
    });
  } catch (error) {
    // A record that never finished says why only if it is read: how far it
    // got, the faces it wore, and what A's frame and the host say now.
    const partial = await app.body("A").evalJS<unknown>(`window.__at0562rec`);
    const frame = await app.body("A").evalJS<unknown>(
      `(function(){var f=document.querySelector(".tug-pane")||document.querySelector(".body-pane-frame");return f===null?null:Array.prototype.map.call(f.attributes,function(a){return a.name+"="+a.value;}).filter(function(s){return /crossing|fold/.test(s);});})()`,
    );
    const host = ((await app.bodies()).find((b) => b.cardId === "A") as { crossing?: unknown } | undefined)?.crossing ?? null;
    note("at0562 handoff record unfinished", { partial, frame, host });
    throw error;
  }
  return app.body("A").evalJS<HandoffRecord>(`window.__at0562rec`);
}

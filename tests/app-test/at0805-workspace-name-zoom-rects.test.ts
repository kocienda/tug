/**
 * AT0805: the zoom rectangles around the workspace naming modal.
 *
 * ## What this pins
 *
 * The naming modal New Workspace and Duplicate Workspace raise says where it
 * came from and where its workspace went, on the classic zoom rectangles the
 * update pill uses (`chrome/zoom-rects.ts`):
 *
 * 1. **Order-in.** Clicking the Workspaces card's `+` runs the rectangles from
 *    the `+` to the panel. The `+` is drawn in the card's own web view and the
 *    run in the overlay's, so the first rectangle standing on the `+`'s own box
 *    *in window points* is the proof that the shell converted the card's rect
 *    rather than passing a body-local one through.
 * 2. **Order-out.** Committing a name runs them from the panel to the new
 *    workspace's header row, the top row of the Workspaces card the cut shows.
 * 3. **Cancel.** Escape runs them from the panel back to the `+` that raised it.
 * 4. **No source, no run.** New raised from the Window menu's row — a door
 *    with no place on screen — plants no rectangle and marks no `data-zoom`,
 *    on the way in or out.
 * 4a. **Seen all the way.** Every frame from the run's first lit frame to its
 *    arrival has a rectangle at full strength: a run that pops each box and
 *    fades it at once reads, on a busy deck, as one that barely appears and
 *    shows only where it bunches at the end.
 * 5. **The scrim comes last both ways.** In, the scrim stays clear while any
 *    rectangle is lit and dims the deck only once the panel has faded in. Out
 *    and on a cancel, a stand-in scrim stays up, undimmed, through every lit
 *    frame, lifts only after the last, and is gone when the census ends. The
 *    menu's door, with no run, plants no stand-in.
 *
 * Motion is sampled, not inferred from end states: each census starts a
 * `requestAnimationFrame` sampler in the overlay page before the gesture and
 * reads every lit rectangle's box each frame. The gesture itself is driven
 * natively in the card's or the shell's page, so the census is armed first
 * and its early frames are simply empty. The timing scale is set to 1 by
 * this file rather than inherited.
 *
 * The look — trail depth, the ease's bunching — is taste and is not pinned.
 * What is pinned is the shape a tuning pass must not break: travel that is
 * monotonic, starts on the source's box and ends on the destination's, a run
 * that cleans up after itself, and no run where there is no source.
 *
 * @covers tugdeck/src/components/chrome/zoom-rects.ts
 * @covers tugdeck/src/components/chrome/workspace-name-dialog.tsx
 * @covers tugdeck/src/components/chrome/workspace-name-dialog.css
 * @covers tugdeck/src/lib/workspace-name-request.ts
 * @covers tugdeck/src/lib/workspace-name-zoom.ts
 * @covers tugdeck/src/lib/new-workspace.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App, type BodyApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { overlayReady } from "./overlay-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const HOME = "zoom-home";
/** A short list, so the new workspace's top row is on screen. */
const PARKED = 3;

const HEADER = `[data-testid="cards-space-header"]`;
const NEW_BUTTON = `[data-testid="cards-new-space"]`;
const NAME_DIALOG = `[data-slot="tug-workspace-name-dialog"]`;
const NAME_FIELD = `[data-slot="tug-workspace-name-field"]`;
const LAYER = `[data-slot="zoom-rects"]`;
const SCRIM = `[data-slot="tug-workspace-name-scrim"]`;
const STAND_IN = `[data-slot="tug-workspace-name-scrim-stand-in"]`;

/** A couple of pixels of rounding: the last rectangle is planted on the destination's measured rect. */
const ARRIVAL_PX = 2;

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One frame of a census. */
interface Sample {
  t: number;
  /** Rectangles standing in the layer, lit or not. */
  planted: number;
  /** The boxes of the rectangles painting anything. */
  lit: Box[];
  /** The strongest opacity among the standing rectangles, 0 when none. */
  peak: number;
  /** Whether the panel is in the DOM. */
  panel: boolean;
  /** The panel's opacity, `null` when it is not in the DOM. */
  panelOpacity: number | null;
  /** The alert's scrim's opacity, `null` when it is not in the DOM. */
  scrim: number | null;
  /** The stand-in scrim's opacity, `null` when none is up. */
  standIn: number | null;
}

function textDeck(cardId: string, paneId: string): Record<string, unknown> {
  return {
    cards: [{ id: cardId, componentId: "text", title: "T", closable: true }],
    panes: [
      {
        id: paneId,
        position: { x: 60, y: 60 },
        size: { width: 600, height: 400 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: paneId,
    imposition: { kind: "one-up", sidebars: {} },
  };
}

/** The home workspace with its Workspaces card in the right rail, and {@link PARKED} parked ones. */
function blob(): Record<string, unknown> {
  const home = {
    cards: [
      { id: "C1", componentId: "cards", title: "Workspaces", closable: true },
      { id: "T0", componentId: "text", title: "T0", closable: true },
    ],
    panes: [
      {
        id: "pc1",
        position: { x: 0, y: 0 },
        size: { width: 420, height: 900 },
        cardIds: ["C1"],
        activeCardId: "C1",
        title: "",
        acceptsFamilies: [] as string[],
      },
      {
        id: "pt0",
        position: { x: 60, y: 60 },
        size: { width: 600, height: 400 },
        cardIds: ["T0"],
        activeCardId: "T0",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "pt0",
    imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  };
  const spaces: { id: string; name: string; deck: Record<string, unknown> }[] = [{ id: HOME, name: "Home", deck: home }];
  for (let i = 1; i <= PARKED; i++) {
    spaces.push({ id: `parked-${i}`, name: `Parked ${i}`, deck: textDeck(`T${i}`, `pt${i}`) });
  }
  return { version: 5, activeSpaceId: HOME, spaces };
}

/**
 * Start the overlay's per-frame sampler. The gesture follows it. It ends four
 * frames after a run's layer has emptied and its scrim has settled, at `ms`
 * with no run, or when
 * {@link stopCensus} is called.
 */
async function armCensus(overlay: BodyApp, ms: number): Promise<void> {
  await overlay.evalJS<null>(
    `(function () {
       document.documentElement.style.setProperty("--tug-timing", "1");
       window.__at0805 = { samples: [], done: false, stop: false, seen: false, empty: 0 };
       var opacityOf = function (sel) {
         var el = document.querySelector(sel);
         return el === null ? null : parseFloat(getComputedStyle(el).opacity);
       };
       var t0 = performance.now();
       var tick = function () {
         var layer = document.querySelector(${JSON.stringify(LAYER)});
         var rects = layer === null ? [] : Array.prototype.slice.call(layer.children);
         var lit = [];
         var peak = 0;
         for (var i = 0; i < rects.length; i += 1) {
           var o = parseFloat(getComputedStyle(rects[i]).opacity);
           if (o > peak) peak = o;
           if (!(o > 0.01)) continue;
           var r = rects[i].getBoundingClientRect();
           lit.push({ left: r.left, top: r.top, width: r.width, height: r.height });
         }
         window.__at0805.samples.push({
           t: performance.now() - t0,
           planted: rects.length,
           lit: lit,
           peak: peak,
           panel: document.querySelector(${JSON.stringify(NAME_DIALOG)}) !== null,
           panelOpacity: opacityOf(${JSON.stringify(NAME_DIALOG)}),
           scrim: opacityOf(${JSON.stringify(SCRIM)}),
           standIn: opacityOf(${JSON.stringify(STAND_IN)}),
         });
         var c = window.__at0805;
         if (rects.length > 0) c.seen = true;
         // Settled means the rectangles and the stand-in scrim are both gone,
         // and a standing scrim has finished dimming: the order-in's scrim
         // starts only after its run has ended.
         var s = window.__at0805.samples[window.__at0805.samples.length - 1];
         var settled = rects.length === 0 && s.standIn === null && (s.scrim === null || s.scrim >= 0.99);
         c.empty = c.seen && settled ? c.empty + 1 : 0;
         if (c.stop || c.empty >= 4 || performance.now() - t0 >= ${ms}) c.done = true;
         else requestAnimationFrame(tick);
       };
       requestAnimationFrame(tick);
       return null;
     })()`,
  );
}

async function readCensus(overlay: BodyApp): Promise<Sample[]> {
  await overlay.waitForCondition<boolean>(`window.__at0805.done === true`, { timeoutMs: 5_000 });
  return overlay.evalJS<Sample[]>(`window.__at0805.samples`);
}

async function stopCensus(overlay: BodyApp): Promise<Sample[]> {
  await overlay.evalJS<boolean>(`(function () { window.__at0805.stop = true; return true; })()`);
  return readCensus(overlay);
}

/** The leading rectangle per lit frame: the widest growing toward the panel, the narrowest shrinking away. */
function leads(samples: Sample[], growing: boolean): Box[] {
  return samples
    .filter((s) => s.lit.length > 0)
    .map((s) => s.lit.reduce((a, b) => ((growing ? b.width > a.width : b.width < a.width) ? b : a)));
}

function near(a: Box, b: Box): boolean {
  return (
    Math.abs(a.left - b.left) <= ARRIVAL_PX &&
    Math.abs(a.top - b.top) <= ARRIVAL_PX &&
    Math.abs(a.width - b.width) <= ARRIVAL_PX &&
    Math.abs(a.height - b.height) <= ARRIVAL_PX
  );
}

/** The largest step against the travel's direction, 0 when there is none. */
function worstRegression(widths: number[], growing: boolean): number {
  let worst = 0;
  for (let i = 1; i < widths.length; i += 1) {
    const back = growing ? widths[i - 1] - widths[i] : widths[i] - widths[i - 1];
    if (back > worst) worst = back;
  }
  return worst;
}

/**
 * Check one run: it starts on `from`, arrives on `to`, travels one way only up
 * to its arrival (the trail drains behind it afterwards), and leaves nothing
 * standing once the census ends. Answers what went wrong, empty for nothing,
 * so every leg is read before the file judges any.
 */
function checkRun(label: string, samples: Sample[], from: Box, to: Box): string[] {
  const growing = to.width > from.width;
  const lead = leads(samples, growing);
  const firstPlanted = samples.findIndex((s) => s.planted > 0);
  const frames = samples
    .slice(Math.max(0, firstPlanted - 2), firstPlanted + 14)
    .map((s) => `${s.t.toFixed(0)}:${s.planted}/${s.lit.length}${s.panel ? "p" : ""}`)
    .join(" ");
  note(`at0805 ${label} frames`, `t:planted/lit from the first planted frame: ${frames}`);
  note(`at0805 ${label}`, `${samples.length} frames, ${lead.length} lit; lead widths ${lead.map((b) => b.width.toFixed(0)).join(" ")}`);
  const wrong: string[] = [];
  if (lead.length <= 2) return [`${label}: only ${lead.length} frames had rectangles lit`];
  // The run's first rectangle is planted on the source's box; a clock that
  // starts before the frames that paint it never shows it lit.
  const firstLit = samples.find((s) => s.lit.length > 0);
  if (!samples.some((s) => s.lit.some((b) => near(b, from)))) {
    wrong.push(`${label}: no rectangle is ever lit on the source's box ${JSON.stringify(from)}; first lit ${JSON.stringify(firstLit?.lit)}`);
  }
  const arrived = lead.findIndex((b) => near(b, to));
  if (arrived < 0) {
    wrong.push(`${label}: the leading rectangle never arrives on the destination's box ${JSON.stringify(to)}; last ${JSON.stringify(lead[lead.length - 1])}`);
  } else if (worstRegression(lead.slice(0, arrived + 1).map((b) => b.width), growing) >= 1) {
    wrong.push(`${label}: the leading rectangle travels back`);
  }
  // Seen all the way: lit frames up to the arrival each carry a box at full strength.
  if (arrived >= 0) {
    const travelling = samples.filter((s) => s.lit.length > 0).slice(0, arrived + 1);
    const weak = travelling.filter((s) => s.peak < 0.99);
    note(`at0805 ${label} peaks`, travelling.map((s) => s.peak.toFixed(2)).join(" "));
    if (weak.length > 0) {
      wrong.push(`${label}: ${weak.length} of ${travelling.length} travelling frames have no rectangle at full strength (first at t=${weak[0].t.toFixed(0)}, peak ${weak[0].peak.toFixed(2)})`);
    }
  }
  if (samples[samples.length - 1].planted !== 0) wrong.push(`${label}: rectangles outlive the run`);
  return wrong;
}

/**
 * Check the order-in's scrim: clear through every lit frame, and first
 * visible no earlier than the frame the panel has all but faded in.
 */
function checkScrimIn(samples: Sample[]): string[] {
  const wrong: string[] = [];
  const dimmedWhileLit = samples.filter((s) => s.lit.length > 0 && s.scrim !== null && s.scrim > 0.01);
  if (dimmedWhileLit.length > 0) {
    wrong.push(`in: the scrim dims while rectangles are lit, from t=${dimmedWhileLit[0].t.toFixed(0)}`);
  }
  const panelUp = samples.findIndex((s) => s.panelOpacity !== null && s.panelOpacity >= 0.9);
  const scrimUp = samples.findIndex((s) => s.scrim !== null && s.scrim > 0.01);
  note("at0805 in scrim", `panel ≥0.9 at frame ${panelUp}, scrim >0.01 at frame ${scrimUp}`);
  if (scrimUp < 0) wrong.push("in: the scrim never dims within the census");
  else if (panelUp < 0 || scrimUp < panelUp) wrong.push(`in: the scrim dims (frame ${scrimUp}) before the panel is in (frame ${panelUp})`);
  return wrong;
}

/**
 * Check a close's scrim: a stand-in up at full strength through every lit
 * frame, lifting only after the last, and gone when the census ends.
 */
function checkScrimOut(label: string, samples: Sample[]): string[] {
  const wrong: string[] = [];
  const lastLit = samples.reduce((at, s, i) => (s.lit.length > 0 ? i : at), -1);
  const firstLit = samples.findIndex((s) => s.lit.length > 0);
  const bare = samples.slice(firstLit, lastLit + 1).filter((s) => s.standIn === null || s.standIn < 0.99);
  if (firstLit >= 0 && bare.length > 0) {
    wrong.push(`${label}: the scrim is lifting or gone while rectangles are lit, at t=${bare[0].t.toFixed(0)} (${bare[0].standIn})`);
  }
  const lifting = samples.findIndex((s) => s.standIn !== null && s.standIn < 0.99);
  note(`at0805 ${label} scrim`, `last lit frame ${lastLit}, stand-in lifting from frame ${lifting}`);
  if (lifting < 0) wrong.push(`${label}: no stand-in scrim was seen lifting`);
  if (samples[samples.length - 1].standIn !== null) wrong.push(`${label}: the stand-in scrim outlives its fade`);
  return wrong;
}

/** `selector`'s box in window points: its box in card `body`'s page, offset by the card's placeholder. */
async function windowBoxOf(app: App, body: BodyApp, selector: string): Promise<Box> {
  const local = await body.evalJS<Box | null>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) return null;
       var r = el.getBoundingClientRect();
       return { left: r.left, top: r.top, width: r.width, height: r.height };
     })()`,
  );
  if (local === null) throw new Error(`${selector} is not in card ${body.cardId}'s page`);
  // card-dom: shell
  const origin = await app.evalJS<{ x: number; y: number }>(
    `(function () {
       var r = document.querySelector('[data-body-placeholder][data-card-id=${JSON.stringify(body.cardId)}]').getBoundingClientRect();
       return { x: r.x, y: r.y };
     })()`,
  );
  return { left: local.left + origin.x, top: local.top + origin.y, width: local.width, height: local.height };
}

async function panelBox(overlay: BodyApp): Promise<Box> {
  await overlay.waitForCondition<boolean>(
    `(function () {
       var f = document.querySelector(${JSON.stringify(NAME_FIELD)});
       return f !== null && document.activeElement === f;
     })()`,
    { timeoutMs: 8_000 },
  );
  return overlay.evalJS<Box>(
    `(function () {
       var r = document.querySelector(${JSON.stringify(NAME_DIALOG)}).getBoundingClientRect();
       return { left: r.left, top: r.top, width: r.width, height: r.height };
     })()`,
  );
}

async function modalGone(overlay: BodyApp): Promise<void> {
  await overlay.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(NAME_DIALOG)}) === null`, {
    timeoutMs: 8_000,
  });
}

describe.skipIf(!SHOULD_RUN)("AT0805: zoom rectangles around the workspace naming modal", () => {
  test(
    "the modal zooms in from the +, out to the new row, back to the + on a cancel, and not at all from the menu",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(blob()));
      const app = await launchTugApp({
        testName: "at0805-workspace-name-zoom-rects",
        env: { TUGBANK_PATH: tugbankPath },
        skipAccessibilityPreflight: true,
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const home = app.body("C1");
        await home.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(HEADER)}).length === ${PARKED + 1}`, {
          timeoutMs: 25_000,
        });
        const overlay = await overlayReady(app);

        // ---- 1. Order-in: + → panel -----------------------------------------
        const plus = await windowBoxOf(app, home, NEW_BUTTON);
        const IN_MS = 1500;
        await armCensus(overlay, IN_MS);
        await home.nativeClickAtElement(NEW_BUTTON);
        const panel = await panelBox(overlay);
        const inSamples = await readCensus(overlay);
        const wrong = checkRun("in", inSamples, plus, panel);
        wrong.push(...checkScrimIn(inSamples));

        // ---- 2. Order-out: panel → the new workspace's top row --------------
        await app.nativeType("Studio");
        const OUT_MS = 4000;
        await armCensus(overlay, OUT_MS);
        await app.nativeKey("Return");
        await modalGone(overlay);
        // card-dom: shell
        const created = await app.evalJS<string>(`window.tugdeck.diag.getSpaces().activeSpaceId`);
        expect(created, "New went to the workspace it made").not.toBe(HOME);
        const out = await readCensus(overlay);
        const bodies = await app.bodies();
        const shown = bodies.find((b) => b.componentId === "cards" && b.visible && b.cardId !== null && b.cardId !== "C1");
        if (shown?.cardId === undefined || shown.cardId === null) throw new Error("the new workspace shows no Workspaces card");
        const card = app.body(shown.cardId);
        const row = await windowBoxOf(app, card, `${HEADER}[data-cards-space-id=${JSON.stringify(created)}]`);
        wrong.push(...checkRun("out", out, panel, row));
        wrong.push(...checkScrimOut("out", out));

        // ---- 3. Cancel: panel → the + that raised it ------------------------
        const plus2 = await windowBoxOf(app, card, NEW_BUTTON);
        await card.nativeClickAtElement(NEW_BUTTON);
        const panel2 = await panelBox(overlay);
        // The order-in run lands, and the panel is up, before the cancel.
        await overlay.waitForCondition<boolean>(
          `(function () {
             var d = document.querySelector(${JSON.stringify(NAME_DIALOG)});
             var layer = document.querySelector(${JSON.stringify(LAYER)});
             return d !== null && (layer === null || layer.children.length === 0) && parseFloat(getComputedStyle(d).opacity) >= 0.99;
           })()`,
          { timeoutMs: 5_000 },
        );
        const CANCEL_MS = 1200;
        await armCensus(overlay, CANCEL_MS);
        await app.nativeKey("Escape");
        await modalGone(overlay);
        const cancelSamples = await readCensus(overlay);
        wrong.push(...checkRun("cancel", cancelSamples, panel2, plus2));
        wrong.push(...checkScrimOut("cancel", cancelSamples));

        // ---- 4. The menu's New: no source, no run, either way ---------------
        const MENU_MS = 4000;
        await armCensus(overlay, MENU_MS);
        await app.dispatchControlAction("new-space");
        await panelBox(overlay);
        const marked = await overlay.evalJS<boolean>(`document.querySelector(${JSON.stringify(NAME_DIALOG)}).hasAttribute("data-zoom")`);
        expect(marked, "a question with no source marks no data-zoom").toBe(false);
        await app.nativeKey("Escape");
        await modalGone(overlay);
        const menu = await stopCensus(overlay);
        note("at0805 menu", `${menu.length} frames, max planted ${Math.max(...menu.map((s) => s.planted))}`);
        expect(menu.some((s) => s.panel), "the census saw the menu's modal").toBe(true);
        expect(menu.every((s) => s.planted === 0), "no rectangle is planted for a door with no place on screen").toBe(true);
        expect(menu.every((s) => s.standIn === null), "a close with no run plants no stand-in scrim").toBe(true);
        expect(wrong, "every sampled run starts on its source and lands on its destination").toEqual([]);
      } finally {
        await app.close().catch(() => undefined);
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

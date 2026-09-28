/**
 * at0642 — a hidden workspace measures, and an observer under it catches up.
 *
 * [L23]'s third class used to say: a mount that may land hidden takes no
 * measurement, because the hidden layer was `display: none` and a pane in it
 * had no boxes. The layer keeps its layout now ([B02] of workspace-switch-
 * cheap), and the rule was re-settled on two facts read off this engine. This
 * is the pin on both — if either stops being true, the gates that were removed
 * on their strength (`tug-pane.tsx`'s controls-width and accessory-height
 * effects, `tug-prompt-entry.tsx`'s line-box re-arm) need to come back, and
 * this file is what says so.
 *
 * ## The two facts
 *
 *  1. **A hidden measurement is real.** Every pane under a hidden layer has a
 *     title bar whose controls read a non-zero `offsetWidth`, and every editor
 *     row in it has a non-zero rect height. And the row height read in the
 *     dark is the row height read on screen — a measurement that does not
 *     depend on where the pane stands is the same measurement either way.
 *  2. **A `ResizeObserver` under a hidden layer is silent, and catches up on
 *     show.** A probe observed inside a hidden pane, then grown, delivers
 *     nothing for as long as the layer is hidden; the moment the layer is
 *     shown it delivers once, with the probe's current size, while the layer
 *     is shown. That ordering is what lets a measurement be observer-backed
 *     with no gate: the observer reads the box when the box is on screen and
 *     never before, at the frame boundary, which is exactly what the shown
 *     gate used to arrange by hand.
 *
 * And the product claim they add up to, read after the round trip:
 *
 *  3. **Nothing on screen is stale.** After the parked workspace is shown
 *     again, every title bar's `--tugx-pane-controls-width` equals its
 *     controls' `offsetWidth` — the observer-only effect published the right
 *     number without a synchronous read in the commit.
 *
 *  4. **A parked pane stands where it will be shown.** Every pane's rect and
 *     its title bar's controls width read in the dark equal the ones read on
 *     screen. `DeckCanvas` arranges every layer from its own deck, the slot
 *     badge answers for a card in a parked deck, and the parked record keeps
 *     its strip offsets — so a switch moves nothing. This is the leg that
 *     goes red if any of those three is undone, and it is why the sheet's
 *     clamps are the only measurement still re-armed on show.
 *
 * `tug-pane.tsx` is the subject and is not named in `@covers`: it stands at
 * the fan-out ceiling in `select-tests.ts`, exactly as `session-card.tsx` does
 * for `at0641`. The rule's home is `space-layer.ts`, whose doc names this
 * file, and the composer's retired re-arm is `line-box-metric.ts`'s.
 *
 * @covers tugdeck/src/components/chrome/space-layer.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/line-box-metric.ts
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SHOWN_LAYER = "[data-space-layer][data-space-shown]";
const HIDDEN_LAYER = "[data-space-layer]:not([data-space-shown])";
const SHOWN_FRAMES = `${SHOWN_LAYER} .tug-pane[data-pane-id]`;

const BAR = '[data-slot="tug-pane-title-bar"]';
const CONTROLS = '[data-testid="tug-pane-title-bar-controls"]';
const CONTROLS_WIDTH_PROPERTY = "--tugx-pane-controls-width";

/** Where the probe leg parks its state on the page. Named so a leak is recognisable. */
const STATE = "__at0642";

const settle = (ms = 400): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The fixture — at0602's shape: one Text card bound to a file on disk, so the
// parked pane has editor rows to measure. A Text card with no file is an
// "Open a file" surface and has no row; the fixture blob at0641 seeds cannot
// bind one, so this is seeded the way at0602 does it.
// ---------------------------------------------------------------------------

const FIXTURE_CONTENT = Array.from(
  { length: 40 },
  (_, i) => `at0642 line ${String(i + 1).padStart(3, "0")}`,
).join("\n") + "\n";

function mkFixture(): { dir: string; file: string } {
  // `realpathSync` because macOS hands back `/var/...` for a `/private/var`
  // temp directory, and the card holds the path it is given.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "at0642-")));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, FIXTURE_CONTENT, "utf8");
  return { dir, file };
}

function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "at0642-text", componentId: "text", title: "File", closable: true },
    ],
    panes: [
      {
        id: "at0642-pane",
        position: { x: 60, y: 40 },
        size: { width: 700, height: 460 },
        cardIds: ["at0642-text"],
        activeCardId: "at0642-text",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "at0642-pane",
    hasFocus: true,
  };
}

// ---------------------------------------------------------------------------
// The readings
// ---------------------------------------------------------------------------

interface PaneMeasure {
  id: string;
  controlsWidth: number;
  /** The first editor row's rect height, or `null` for a pane with no editor. */
  rowHeight: number | null;
  /** The bar's published controls-width property, as computed. */
  published: string;
  /** The frame's rect, rounded — where the pane stands. */
  rect: number[];
}

/** Every pane under `selector`, measured. Reads the same things whether the layer is hidden or shown. */
const measureRead = (selector: string): string => `(function () {
  var layers = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(selector)}));
  var out = [];
  layers.forEach(function (l) {
    var panes = l.querySelectorAll(".tug-pane[data-pane-id]");
    for (var i = 0; i < panes.length; i++) {
      var p = panes[i];
      var bar = p.querySelector(${JSON.stringify(BAR)});
      var controls = p.querySelector(${JSON.stringify(CONTROLS)});
      var row = p.querySelector(".cm-line");
      out.push({
        id: p.getAttribute("data-pane-id"),
        controlsWidth: controls === null ? -1 : controls.offsetWidth,
        rowHeight: row === null ? null : row.getBoundingClientRect().height,
        published: bar === null ? "" : window.getComputedStyle(bar).getPropertyValue(${JSON.stringify(CONTROLS_WIDTH_PROPERTY)}).trim(),
        rect: (function (r) { return [r.left, r.top, r.width, r.height].map(Math.round); })(p.getBoundingClientRect())
      });
    }
  });
  return out;
})()`;

interface ProbeState {
  installed: boolean;
  grown: boolean;
  deliveries: { width: number; shown: boolean; ticks: number }[];
  /** rAF ticks counted since install — the liveness reading [P10] needs. */
  ticks: number;
  ticksAtSwitch: number;
}

/**
 * Install a probe inside the first hidden pane: a 50px box with a
 * `ResizeObserver` on it, and a rAF counter so a delivery can be placed
 * against the frames that actually ran. State lives on `window[STATE]`.
 */
const PROBE_INSTALL = `(function () {
  var hidden = document.querySelector(${JSON.stringify(HIDDEN_LAYER)});
  if (hidden === null) return false;
  var pane = hidden.querySelector(".tug-pane[data-pane-id]");
  if (pane === null) return false;
  var probe = document.createElement("div");
  probe.setAttribute("data-at0642-probe", "");
  probe.style.cssText = "position:absolute;left:0;top:0;width:50px;height:10px;pointer-events:none";
  pane.appendChild(probe);
  var state = { installed: true, grown: false, deliveries: [], ticks: 0, ticksAtSwitch: -1, probe: probe, ro: null, raf: 0 };
  var tick = function () { state.ticks += 1; state.raf = requestAnimationFrame(tick); };
  state.raf = requestAnimationFrame(tick);
  state.ro = new ResizeObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      state.deliveries.push({
        width: entries[i].contentRect.width,
        shown: hidden.hasAttribute("data-space-shown"),
        ticks: state.ticks
      });
    }
  });
  state.ro.observe(probe);
  window[${JSON.stringify(STATE)}] = state;
  return true;
})()`;

const PROBE_GROW = `(function () {
  var state = window[${JSON.stringify(STATE)}];
  state.probe.style.width = "80px";
  state.grown = true;
  return state.probe.offsetWidth;
})()`;

const PROBE_READ = `(function () {
  var s = window[${JSON.stringify(STATE)}];
  return { installed: s.installed, grown: s.grown, deliveries: s.deliveries, ticks: s.ticks, ticksAtSwitch: s.ticksAtSwitch };
})()`;

/** Note the frame count and dispatch the switch in the same task, so the delivery can be placed against it. */
const switchAndMark = (spaceId: string): string => `(function () {
  var s = window[${JSON.stringify(STATE)}];
  s.ticksAtSwitch = s.ticks;
  window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} });
  return s.ticksAtSwitch;
})()`;

const PROBE_REMOVE = `(function () {
  var s = window[${JSON.stringify(STATE)}];
  if (!s) return 0;
  if (s.ro) s.ro.disconnect();
  if (s.raf) cancelAnimationFrame(s.raf);
  if (s.probe && s.probe.parentNode) s.probe.parentNode.removeChild(s.probe);
  delete window[${JSON.stringify(STATE)}];
  return 1;
})()`;

const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

describe.skipIf(!SHOULD_RUN)(
  "at0642 — a hidden workspace measures, and an observer under it catches up",
  () => {
    test(
      "real boxes in the dark; observer silent hidden and delivered on show; nothing stale on screen",
      async () => {
        const fixture = mkFixture();
        const app = await launchTugApp({ testName: "at0642-hidden-layer-measures" });
        try {
          // The save mode the card reads at mount, seeded the way at0602 does.
          await app.evalJS<null>(
            `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:"manual"}), null)`,
          );
          await app.seedDeckState({
            state: deckShape(),
            cardStates: {
              "at0642-text": {
                content: { path: fixture.file, anchor: { line: 1, ch: 0 }, scrollTop: 0 },
              },
            },
            focusCardId: "at0642-text",
          });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(`${SHOWN_FRAMES} .cm-line`)}).length > 0`,
            { timeoutMs: 30_000 },
          );
          await settle(800);
          const home = await app.evalJS<string>(ACTIVE_SPACE);

          // Park the home workspace behind a new one, through the real verb
          // the Window menu sends. From here the new workspace is shown and
          // home is the hidden layer every dark reading is taken from.
          await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
          await app.waitForCondition<boolean>(
            `${ACTIVE_SPACE} !== ${JSON.stringify(home)} && document.querySelector(${JSON.stringify(HIDDEN_LAYER)}) !== null`,
            { timeoutMs: 15_000 },
          );
          await settle(800);

          // ---- 1. A hidden measurement is real. ---------------------------
          const dark = await app.evalJS<PaneMeasure[]>(measureRead(HIDDEN_LAYER));
          note(`at0642 dark: ${JSON.stringify(dark)}`);
          expect(dark.length, "the hidden workspace's panes are standing").toBeGreaterThan(0);
          for (const p of dark) {
            expect(p.controlsWidth, `hidden pane ${p.id}: controls have a width`).toBeGreaterThan(0);
          }
          const darkRows = dark.filter((p) => p.rowHeight !== null);
          expect(darkRows.length, "at least one hidden pane has an editor row to measure").toBeGreaterThan(0);
          for (const p of darkRows) {
            expect(p.rowHeight as number, `hidden pane ${p.id}: the row has a height`).toBeGreaterThan(0);
          }

          // ---- 2. The observer is silent in the dark. ---------------------
          const installed = await app.evalJS<boolean>(PROBE_INSTALL);
          expect(installed, "a probe was installed inside a hidden pane").toBe(true);
          await settle(200);
          const grownTo = await app.evalJS<number>(PROBE_GROW);
          expect(grownTo, "the probe's box is real in the dark — it grew").toBe(80);
          await settle(300);
          const silent = await app.evalJS<ProbeState>(PROBE_READ);
          note(`at0642 dark observer: ${JSON.stringify(silent)}`);
          expect(
            silent.deliveries.length,
            "no delivery while the layer is hidden — neither the initial observation nor the growth",
          ).toBe(0);
          const rafLive = silent.ticks > 0;
          if (!rafLive) {
            note("at0642: rAF did not tick while hidden — frame placement below is void, not low [P10]");
          }

          // ---- 3. …and catches up the moment the layer is shown. ---------
          const ticksAtSwitch = await app.evalJS<number>(switchAndMark(home));
          await app.waitForCondition<boolean>(
            `${ACTIVE_SPACE} === ${JSON.stringify(home)}`,
            { timeoutMs: 15_000 },
          );
          await app.waitForCondition<boolean>(
            `window[${JSON.stringify(STATE)}].deliveries.length > 0`,
            { timeoutMs: 5_000 },
          );
          await settle(300);
          const caught = await app.evalJS<ProbeState>(PROBE_READ);
          note(`at0642 shown observer: ${JSON.stringify(caught)} (switched at tick ${ticksAtSwitch})`);
          expect(caught.deliveries.length, "exactly one delivery: the catch-up").toBe(1);
          expect(caught.deliveries[0]!.width, "and it carries the probe's CURRENT size, not the one it was observed at").toBe(80);
          expect(caught.deliveries[0]!.shown, "delivered while the layer was shown").toBe(true);
          if (rafLive && caught.ticks > ticksAtSwitch) {
            // The switch commits in its own task; the next frame runs its rAF
            // callbacks, lays out, delivers observations, and paints. A
            // delivery on the first tick after the switch is one that landed
            // before that frame's paint — the ordering the gate-less
            // measurement rests on.
            expect(
              caught.deliveries[0]!.ticks - ticksAtSwitch,
              "delivered in the first frame after the switch, before it painted",
            ).toBeLessThanOrEqual(1);
          } else {
            note("at0642: no frame ran across the switch — frame placement void, not low [P10]");
          }

          // ---- 4. Nothing on screen is stale, and the dark reading was the shown one. ----
          const shown = await app.evalJS<PaneMeasure[]>(measureRead(SHOWN_LAYER));
          note(`at0642 shown: ${JSON.stringify(shown)}`);
          expect(shown.length, "the same panes are on screen").toBe(dark.length);
          for (const p of shown) {
            expect(
              p.published,
              `shown pane ${p.id}: the observer-only effect published the controls' real width`,
            ).toBe(`${p.controlsWidth}px`);
          }
          const byId = new Map(shown.map((p) => [p.id, p] as const));
          for (const p of dark) {
            const s = byId.get(p.id);
            expect(s, `pane ${p.id} is still on screen`).toBeDefined();
            expect(
              s!.rect,
              `pane ${p.id}: it stands where it stood in the dark — the switch moved nothing`,
            ).toEqual(p.rect);
            expect(
              s!.controlsWidth,
              `pane ${p.id}: the title bar rendered the same controls hidden and shown`,
            ).toBe(p.controlsWidth);
          }
          for (const p of darkRows) {
            const s = byId.get(p.id);
            expect(s, `pane ${p.id} is still on screen`).toBeDefined();
            expect(
              s!.rowHeight,
              `pane ${p.id}: the row height read in the dark is the one read on screen`,
            ).toBe(p.rowHeight);
          }
        } finally {
          // The app may already be gone; the probe goes with it.
          await app.evalJS<number>(PROBE_REMOVE).catch(() => undefined);
          await app.close().catch(() => undefined);
          fs.rmSync(fixture.dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

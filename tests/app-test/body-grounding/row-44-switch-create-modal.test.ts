/**
 * row-44-switch-create-modal.test.ts — New Workspace asks for the name in an
 * app-modal, and the only thing that moves under its scrim is one cut onto a
 * finished rail.
 *
 * New Workspace is answered by a question, not by the new workspace: an
 * app-modal in the overlay page puts a scrim over the whole window and asks
 * for the name, while the new workspace is built out of sight and its rail
 * cards' pages are made hidden. Commit applies the name and cuts to it under
 * the scrim, waiting (bounded) for the pages, and the scrim fades over the
 * finished picture. One recording reads the whole gesture, from the control
 * action to the scrim's last frame, and holds four bars:
 *
 *   1. **Still under the scrim.** From the scrim standing to the cut, no
 *      frame differs from the first scrimmed frame anywhere outside the
 *      dialog's panel: the departing workspace stands still while the user
 *      reads and types, and nothing of the new one shows through.
 *   2. **One cut.** The shell's active workspace changes once, and the deck
 *      commits the arrangement once — one `activateSpace` notify, spelled
 *      `"cut"`, and no factory rail standing behind it as a second commit.
 *   3. **A finished rail from the cut.** From the first host tick that puts
 *      any rail card on screen, every rail card is on screen with its own
 *      painted page: no host face, no shell stand-in (the lid), and no frame
 *      after the scrim has gone showing the canvas through a rail pane.
 *   4. **Nothing moves after the cut.** Every pane rect the shell reads at the
 *      cut is the one it reads at the end, and the canvas arms no settle that
 *      carries a pane.
 *
 * The dialog is read where the app-modals draw: the overlay page
 * (`[data-slot="tug-workspace-name-dialog"]`, its field
 * `[data-slot="tug-workspace-name-field"]`), and committed with a native
 * Return, the key a person presses. The test holds the modal open for a
 * person's read of it before committing, so the hidden pages are being made
 * while it stands.
 *
 * Beside the bars it notes what the recording shows of the gesture as a
 * whole — when each consecutive pair of frames differed, the shell's
 * workspace and stand-in log, and each rail card's host faces and first page
 * — which is what tells one flash from another when the bars fail.
 *
 * It sits in row 44's family: the same judge's subject, the create, read
 * through the gesture that now carries it.
 *
 * @family row-44-switch
 * @motion
 * @covers tugdeck/src/deck-manager.ts
 * @covers tugdeck/src/spaces-store.ts
 * @covers tugdeck/src/components/tugways/app-gates.tsx
 * @covers tugdeck/src/lib/body-make-ahead.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyLayerRow, BodyLayersReading, CaptureBurstFrame, CaptureBurstReading } from "../_harness/client";
import { decodePngFile, type DecodedPng } from "../_harness/png";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { overlayReady } from "../overlay-fixture";
import { bodyOf, settleFor } from "./_bodies";
import { asRgbJs, FLOOR_COLUMNS, gridColumnsIn, parseRgb, type FrameRegion, type Rgb } from "./_frames";
import { ACTIVE_SPACE, canvasShare, SHOULD_RUN, TEST_TIMEOUT_MS, textDeck, type Rect } from "./_row-44";

const H = "r44m-home";
const HOME = "r44m-home-space";

const LAYOUT = {
  version: 5,
  activeSpaceId: HOME,
  spaces: [{ id: HOME, name: "Home", deck: textDeck([H]) }],
};

const DIALOG = '[data-slot="tug-workspace-name-dialog"]';
const FIELD = '[data-slot="tug-workspace-name-field"]';

/** How long the modal is given to open after the gesture. */
const OPEN_MS = 1_500;
/** How long a person reads the modal before pressing Return: the pages are being made meanwhile. */
const HOLD_MS = 1_500;
/** How long the scrim takes to stand: frames inside it are the scrim fading in, not the picture moving. */
const SCRIM_IN_MS = 300;
/** How long the scrim takes to go once the dialog has left the page. */
const SCRIM_OUT_MS = 400;
/** The bound on the commit's wait for pages, mirroring the host's reveal-set horizon. */
const COMMIT_BOUND_MS = 2_000;
/** The burst: the standing read, the open, the hold, the commit's bound, the fade, and a margin. */
const BURST_MS = 120 + OPEN_MS + HOLD_MS + COMMIT_BOUND_MS + SCRIM_OUT_MS + 300;
const BURST_INTERVAL_MS = 50;
/** How long the burst reads the standing workspace before the gesture. */
const STANDING_MS = 120;
/** The panel's shadow and focus ring, around its rect, are the dialog's own paint. */
const PANEL_PAD = 32;
const TOLERANCE = 8;
/** A frame differs from another when this share of its sampled pixels does. */
const DIFFER_SHARE = 0.002;
/** How much more of a rail pane's box may be canvas than in the settled frame. */
const BOX_CANVAS_SLACK = 0.005;

interface TraceRow {
  kind: string;
  caller?: string;
  landing?: string;
  signature?: string;
  outcome?: string;
  reason?: string;
}

/** One change the shell's frame recorder saw. */
interface ShellEntry {
  wall: number;
  active: string;
  standIns: number;
  /** Every pane's rect, `id x,y wxh`, sorted. */
  panes: string;
}

/**
 * The shell's recorder: on every animation frame, the active workspace, the
 * stand-ins standing and the pane rects, logged only when one changes.
 */
const INSTALL_SHELL_RECORDER = `(function () {
  var log = [];
  var last = "";
  var on = true;
  function read() {
    var panes = Array.prototype.map.call(document.querySelectorAll(".tug-pane[data-pane-id]"), function (el) {
      var r = el.getBoundingClientRect();
      if (r.width === 0) return null;
      return el.getAttribute("data-pane-id") + " " + Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "x" + Math.round(r.height);
    }).filter(function (s) { return s !== null; }).sort().join("; ");
    return {
      active: window.tugdeck.diag.getSpaces().activeSpaceId,
      standIns: document.querySelectorAll("[data-body-stand-in]").length,
      panes: panes,
    };
  }
  function tick() {
    if (!on) return;
    var e = read();
    var key = e.active + "|" + e.standIns + "|" + e.panes;
    if (key !== last) {
      last = key;
      log.push({ wall: Date.now(), active: e.active, standIns: e.standIns, panes: e.panes });
    }
    requestAnimationFrame(tick);
  }
  tick();
  window.__r44m = { log: log, stop: function () { on = false; } };
  return null;
})()`;

const decodedCache = new Map<string, DecodedPng>();
const png = (f: CaptureBurstFrame): DecodedPng => {
  let p = decodedCache.get(f.path);
  if (p === undefined) {
    p = decodePngFile(f.path);
    decodedCache.set(f.path, p);
  }
  return p;
};

/** Whether two frames differ anywhere outside `mask` (device pixels). */
function differsOutside(a: CaptureBurstFrame, b: CaptureBurstFrame, mask: FrameRegion | null): boolean {
  const p = png(a);
  const q = png(b);
  if (p.width !== q.width || p.height !== q.height) return true;
  let differing = 0;
  let sampled = 0;
  for (let y = 0; y < p.height; y += 4) {
    for (let x = 0; x < p.width; x += 4) {
      if (mask !== null && x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height) continue;
      const i = (y * p.width + x) * 4;
      sampled += 1;
      if (
        Math.abs(p.rgba[i] - q.rgba[i]) > TOLERANCE ||
        Math.abs(p.rgba[i + 1] - q.rgba[i + 1]) > TOLERANCE ||
        Math.abs(p.rgba[i + 2] - q.rgba[i + 2]) > TOLERANCE
      ) {
        differing += 1;
      }
    }
  }
  return differing / Math.max(1, sampled) >= DIFFER_SHARE;
}

/** The latest layer row for `cardId` at or before `wall`. */
const rowAt = (rows: readonly BodyLayerRow[], cardId: string, wall: number): BodyLayerRow | undefined =>
  rows.filter((r) => r.cardId === cardId && r.wall <= wall).at(-1);

const onScreen = (r: BodyLayerRow): boolean => !r.hidden && r.opacity > 0 && r.held !== true;

describe.skipIf(!SHOULD_RUN)("body-grounding row 44: New Workspace through its naming modal", () => {
  test(
    "the departing workspace stands still under the scrim, and commit is one cut onto a finished rail",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const app: App = await launchTugApp({
        testName: "body-grounding-row-44-switch-create-modal",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const home = await settleFor(() => bodyOf(app, H), (b) => b?.state === "ready" && b.painted && b.visible, 30_000);
        expect(home?.visible, "the shown workspace's card is a body, shown").toBe(true);
        const overlay = await overlayReady(app);

        const width = await app.evalJS<number>("window.innerWidth");
        const height = await app.evalJS<number>("window.innerHeight");
        const mark = await app.evalJS<number>("(window.__deckTrace.enable(true), window.__deckTrace.mark())");
        await app.evalJS<null>(INSTALL_SHELL_RECORDER);
        await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop: { x: 0, y: 0, width, height } });
        await app.bodyLayers({ op: "arm", windowMs: BURST_MS });
        await Bun.sleep(STANDING_MS);

        const bad: string[] = [];
        const gestureWall = Date.now();
        await app.evalJS<null>(`(window.__tug.dispatchControlAction("new-space"), null)`);

        // The modal, its field holding the keyboard with the proposed name selected.
        let openedWall: number | null = null;
        let panel: Rect | null = null;
        try {
          await overlay.waitForCondition<boolean>(
            `(function () {
               var f = document.querySelector(${JSON.stringify(FIELD)});
               return f !== null && document.activeElement === f && document.documentElement.getAttribute("data-overlay-claim-state") === "all";
             })()`,
            { timeoutMs: OPEN_MS },
          );
          openedWall = Date.now();
          panel = await overlay.evalJS<Rect | null>(
            `(function () {
               var d = document.querySelector(${JSON.stringify(DIALOG)});
               if (d === null) return null;
               var r = d.getBoundingClientRect();
               return { x: r.x, y: r.y, width: r.width, height: r.height };
             })()`,
          );
        } catch {
          bad.push(`New Workspace opened no naming modal within ${OPEN_MS} ms`);
        }

        let committedWall: number | null = null;
        let closedWall: number | null = null;
        if (openedWall !== null) {
          await Bun.sleep(HOLD_MS);
          committedWall = Date.now();
          await app.nativeKey("Return");
          try {
            await overlay.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(DIALOG)}) === null && document.documentElement.getAttribute("data-overlay-claim-state") !== "all"`,
              { timeoutMs: COMMIT_BOUND_MS + 2_000 },
            );
            closedWall = Date.now();
          } catch {
            bad.push(`the modal was still up ${COMMIT_BOUND_MS + 2_000} ms after Return`);
          }
        }

        // The new workspace's cards, once it is the shown one.
        const active = await settleFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== HOME, 5_000);
        if (active === HOME) bad.push("New Workspace never showed a new workspace");
        const rail = active === HOME ? [] : await app.evalJS<string[]>("window.tugdeck.diag.getDeckState().cards.map(function (c) { return c.id; })");
        for (const id of rail) {
          const b = await settleFor(() => bodyOf(app, id), (s) => s?.state === "ready" && s.painted === true && s.visible && !s.covered, 10_000);
          if (b?.painted !== true || b.visible !== true) bad.push(`${id}: its page never painted and showed`);
        }

        const reading = await settleFor(
          () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
          (r) => r.done,
          BURST_MS + 5_000,
        );
        const layers = (await settleFor(
          () => app.bodyLayers({ op: "read" }) as Promise<BodyLayersReading>,
          (r) => r.done,
          BURST_MS + 5_000,
        )) as BodyLayersReading;
        const shellLog = await app.evalJS<ShellEntry[]>("(window.__r44m.stop(), window.__r44m.log)");
        const trace = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify(window.__deckTrace.since(${mark}).filter(function (e) {
               return e.kind === "store-notify" || e.kind === "settle-arm";
             }).map(function (e) {
               return { kind: e.kind, caller: e.caller, landing: e.landing, signature: e.signature, outcome: e.outcome, reason: e.reason };
             }))`,
          ),
        ) as TraceRow[];
        expect(reading.done, "the burst finished").toBe(true);
        expect(layers.done, "the host's layer rows finished").toBe(true);

        const at = (w: number) => `${Math.round(w - gestureWall)} ms`;
        const frames = reading.frames;
        const scale = reading.scale;
        const px = (r: Rect, pad = 0): FrameRegion => ({
          x: (r.x - pad) * scale,
          y: (r.y - pad) * scale,
          width: (r.width + 2 * pad) * scale,
          height: (r.height + 2 * pad) * scale,
        });
        const mask = panel === null ? null : px(panel, PANEL_PAD);

        // What the recording shows of the gesture as a whole.
        const changes: string[] = [];
        for (let i = 1; i < frames.length; i++) {
          if (frames[i].wall < gestureWall) continue;
          if (differsOutside(frames[i - 1], frames[i], null)) changes.push(at(frames[i].wall));
        }
        note(`row-44-switch-create-modal: ${frames.length} frames; consecutive frames differed at ${changes.join(", ") || "no point"}`);
        note(
          `row-44-switch-create-modal: modal ${openedWall === null ? "never opened" : `open at ${at(openedWall)}`}` +
            `${committedWall === null ? "" : `, Return at ${at(committedWall)}`}${closedWall === null ? "" : `, gone at ${at(closedWall)}`}`,
        );
        note(
          `row-44-switch-create-modal: shell ${shellLog.map((e) => `${at(e.wall)} ${e.active === HOME ? "home" : "new"} stand-ins ${e.standIns} [${e.panes}]`).join(" | ")}`,
        );
        for (const id of rail) {
          const own = layers.rows.filter((r) => r.cardId === id && r.wall >= gestureWall);
          const facedRows = own.filter((r) => r.faced);
          const firstOn = own.find((r) => onScreen(r) || r.faced);
          const firstPage = own.find((r) => onScreen(r) && !r.faced && r.painted);
          note(
            `row-44-switch-create-modal: ${id} first on screen ${firstOn === undefined ? "never" : `${at(firstOn.wall)} (${firstOn.faced ? "face" : firstOn.painted ? "page" : "unpainted"})`}, ` +
              `faced ${facedRows.length === 0 ? "never" : `${at(facedRows[0].wall)}–${at(facedRows[facedRows.length - 1].wall)}`}, ` +
              `page first shown ${firstPage === undefined ? "never" : at(firstPage.wall)}`,
          );
        }

        // The cut, as the shell saw it.
        const cutEntry = shellLog.find((e) => e.active !== HOME);
        const cutWall = cutEntry?.wall ?? null;
        const actives = shellLog.map((e) => e.active).filter((a, i, all) => i === 0 || a !== all[i - 1]);

        // 1. Still under the scrim, from the scrim standing to the cut.
        if (openedWall !== null) {
          // The question comes first: nothing of the new workspace before the modal is up.
          if (cutWall !== null && cutWall < openedWall) bad.push(`the deck cut to the new workspace at ${at(cutWall)}, before the modal had opened`);
          const spanEnd = cutWall ?? Infinity;
          const span = frames.filter((f) => f.wall >= openedWall + SCRIM_IN_MS && f.wall < spanEnd);
          const reference = span[0];
          if (reference === undefined) {
            bad.push("no frame was captured under the standing scrim before the cut");
          } else {
            const moved = span.filter((f) => differsOutside(reference, f, mask));
            if (moved.length > 0) {
              bad.push(`under the scrim the picture moved in ${moved.length} frames before the cut: ${moved.slice(0, 8).map((f) => at(f.wall)).join(", ")}`);
            }
          }
        }

        // 2. One cut.
        if (actives.filter((a) => a !== HOME).length !== 1 || actives[0] !== HOME) {
          bad.push(`the shell's workspace went ${actives.map((a) => (a === HOME ? "home" : a)).join(" → ")}, not home → new once`);
        }
        const notifies = trace.filter((e) => e.kind === "store-notify");
        const activations = notifies.filter((e) => e.caller === "activateSpace");
        const rails = notifies.filter((e) => e.caller === "_createFactoryRail" || e.caller === "claimFactoryRail");
        note(`row-44-switch-create-modal: store-notify ${notifies.map((e) => `${e.caller}:${e.landing}`).join(", ") || "none"}`);
        if (activations.map((e) => e.landing).join(",") !== "cut") {
          bad.push(`the activation committed as [${activations.map((e) => e.landing).join(", ")}], not one cut`);
        }
        if (rails.length > 0) bad.push(`a rail stood behind the cut as a second commit: ${rails.map((e) => e.caller).join(", ")}`);

        // 3. A finished rail from the cut.
        const railRows = layers.rows.filter((r) => rail.includes(r.cardId) && r.wall >= gestureWall);
        const hostCut = railRows.find((r) => onScreen(r) || r.faced)?.wall ?? null;
        if (hostCut === null && rail.length > 0) {
          bad.push("the host never put a rail card on screen in the window");
        } else if (hostCut !== null) {
          const ticks = [...new Set(railRows.filter((r) => r.wall >= hostCut).map((r) => r.wall))];
          const unfinished = new Map<string, string>();
          for (const wall of ticks) {
            for (const id of rail) {
              if (unfinished.has(id)) continue;
              const row = rowAt(layers.rows, id, wall);
              if (row === undefined) unfinished.set(id, `${id} had no host row at ${at(wall)}`);
              else if (row.faced) unfinished.set(id, `${id} stood a host face at ${at(wall)}`);
              else if (!onScreen(row)) unfinished.set(id, `${id} was off screen at ${at(wall)} while the rail showed`);
              else if (!row.painted) unfinished.set(id, `${id} was on screen unpainted at ${at(wall)}`);
            }
          }
          bad.push(...unfinished.values());
        }
        if (cutWall !== null) {
          const lidded = shellLog.filter((e) => e.wall >= cutWall && e.standIns > 0);
          if (lidded.length > 0) bad.push(`the shell stood ${Math.max(...lidded.map((e) => e.standIns))} stand-ins after the cut, first at ${at(lidded[0].wall)}`);
        }
        // Past the scrim, a rail pane's box shows no more canvas than it settles with.
        const clear = closedWall === null ? null : closedWall + SCRIM_OUT_MS;
        if (clear !== null && cutEntry !== undefined && frames.length > 0) {
          const last = frames[frames.length - 1];
          const settled = png(last);
          const canvas: Rgb = parseRgb(await app.evalJS<string>(asRgbJs(`getComputedStyle(document.body).getPropertyValue('--tug7-surface-global-primary-normal-canvas-rest')`)));
          const rects: Record<string, Rect> = {};
          for (const id of rail) {
            const r = await app.evalJS<Rect | null>(
              `(function () {
                 var ph = document.querySelector('[data-body-placeholder][data-card-id="${id}"]');
                 var el = ph === null ? null : ph.closest(".tug-pane");
                 if (el === null) return null;
                 var b = el.getBoundingClientRect();
                 return b.width > 0 ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
               })()`,
            );
            if (r !== null) rects[id] = r;
          }
          const boxOf = (r: Rect): FrameRegion => px({ x: r.x + 4, y: r.y + 4, width: r.width - 8, height: r.height - 8 });
          for (const f of frames.filter((f) => f.wall >= clear)) {
            for (const [id, r] of Object.entries(rects)) {
              const floor = canvasShare(png(f), boxOf(r), canvas);
              const settledFloor = canvasShare(settled, boxOf(r), canvas);
              if (floor > settledFloor + BOX_CANVAS_SLACK && gridColumnsIn(png(f), canvas, boxOf(r)) >= FLOOR_COLUMNS) {
                bad.push(`${id} at ${at(f.wall)}: its box showed the canvas, ${(floor * 100).toFixed(1)}% against settled ${(settledFloor * 100).toFixed(1)}%`);
              }
            }
          }
        }

        // 4. Nothing moves after the cut.
        if (cutEntry !== undefined) {
          const after = shellLog.filter((e) => e.wall >= cutEntry.wall);
          const arrangements = [...new Set(after.map((e) => e.panes))];
          if (arrangements.length > 1) {
            bad.push(`the pane rects moved after the cut: ${arrangements.length} arrangements, ${after.map((e) => at(e.wall)).join(", ")}`);
          }
        }
        const arms = trace.filter((e) => e.kind === "settle-arm");
        note(`row-44-switch-create-modal: settle-arm ${arms.map((e) => `${e.outcome}${e.reason !== undefined ? `/${e.reason}` : ""}`).join(", ") || "none"}`);
        const carried = arms.filter((e) => e.outcome === "carried");
        if (carried.length > 0) bad.push(`${carried.length} settles carried a pane after the cut`);
        if (new Set(arms.map((e) => e.signature)).size > 1) bad.push("the canvas armed on more than one arrangement");

        if (bad.length > 0) note(`row-44-switch-create-modal: ${bad.slice(0, 12).join("; ")}${bad.length > 12 ? ` (+${bad.length - 12} more)` : ""}`);
        expect(bad, "New Workspace asks for the name, holds the departing picture still under the scrim, and cuts once onto a finished rail").toEqual([]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

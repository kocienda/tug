/**
 * row-38-evicted-no-cover.test.ts — a card evicted without a cover comes back
 * under its stand-in, never the floor, and an eviction whose snapshot never
 * answers still goes.
 *
 * A Session card is hidden past a shortened `evictAfterMs` by parking its
 * workspace, and the clock evicts it. The host is launched so that the
 * eviction's snapshot never answers (`TUG_BODY_STALL_SNAPSHOTS`), which is a
 * snapshot that failed taken to its worst: the eviction must go on at the
 * snapshot's deadline without a cover rather than standing `evicting` for
 * ever. Shown again, the card has no last frame to stand under, so the host
 * says nothing of a cover and the shell does not show the card from its
 * hand-off: its stand-in stands until the new page paints, as for any
 * arrival, and every composited frame of the pane from the reveal on is read
 * for the floor's grid (`gridColumns`) and the bare window — none may show
 * either.
 *
 * @family row-38
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, pollFor, sessionPane } from "./_bodies";
import { classifyFrame, FLOOR_COLUMNS, gridColumns, readPalette } from "./_frames";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r38n-a";
/** The reader's delay before eviction, shortened from fifteen minutes for the row. */
const EVICT_AFTER_MS = 1_000;
/** The host's `saveDeadline`, which the snapshot's deadline is too. */
const SNAPSHOT_DEADLINE_MS = 2_000;
const BURST_MS = 2_000;
const BURST_INTERVAL_MS = 33;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The shell's placeholder for `cardId`, in viewport points, or null while it has no box. */
const placeholderRect = (app: App, cardId: string): Promise<Rect | null> =>
  // card-dom: shell — the placeholder is the shell's.
  app.evalJS<Rect | null>(
    `(function () {
      var el = document.querySelector('[data-body-placeholder][data-card-id="${cardId}"]');
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    })()`,
  );

describe.skipIf(!SHOULD_RUN)("body-grounding row 38: an eviction with no cover", () => {
  test(
    "an eviction whose snapshot never answers goes coverless, and the card comes back under its stand-in, never the floor",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r38n-project-")));
      onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
      const app = await launchTugApp({ testName: "body-grounding-row-38-evicted-no-cover", env: { TUG_BODY_STALL_SNAPSHOTS: "1" } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 30_000);
        await app.spawnSessionNew(A, { tugSessionId: randomUUID(), projectDir });
        const rect = await pollFor(() => placeholderRect(app, A), (r) => r !== null, 5_000);
        expect(rect, "the pane's placeholder has a box").not.toBeNull();
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.body-dormancy", "evictAfterMs", { kind: "i64", value: ${EVICT_AFTER_MS} }), null)`,
        );

        // ---- Parked; the clock evicts it, its snapshot never answering ----
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        const hiddenAt = Date.now();
        const gone = await pollFor(
          () => app.bodies(),
          (all) => !all.some((b) => b.cardId === A),
          EVICT_AFTER_MS + SNAPSHOT_DEADLINE_MS + 6_000,
        );
        const goneMs = Date.now() - hiddenAt;
        note(`evicted with its snapshot unanswered ${goneMs} ms after it was hidden, for a delay of ${EVICT_AFTER_MS} ms and a snapshot deadline of ${SNAPSHOT_DEADLINE_MS} ms`);
        expect(gone.some((b) => b.cardId === A), "the eviction went on at the snapshot's deadline").toBe(false);
        expect(goneMs, "it waited out the snapshot's deadline before it went").toBeGreaterThanOrEqual(EVICT_AFTER_MS + SNAPSHOT_DEADLINE_MS - 300);

        // ---- Shown again: no cover, so the stand-in stands until the page paints ----
        const inset = 4;
        const crop = { x: rect!.x + inset, y: rect!.y + inset, width: rect!.width - 2 * inset, height: rect!.height - 2 * inset };
        await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
        // Each shell frame from the reveal on: whether the card's stand-in face is in its placeholder.
        await app.evalJS<null>(`(function () {
          var log = (window.__r38nFaces = []);
          var until = Date.now() + ${BURST_MS};
          (function tick() {
            var ph = document.querySelector('[data-body-placeholder][data-card-id="${A}"]');
            log.push([Date.now(), ph === null ? -1 : ph.querySelector("[data-body-stand-in]") === null ? 0 : 1]);
            if (Date.now() < until) requestAnimationFrame(tick);
          })();
          return null;
        })()`);
        const shownWall = Date.now();
        const shown = performance.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        let shownBeforePaint = false;
        let hostShownWall: number | null = null;
        const back = await pollFor(
          async () => {
            const b = await bodyOf(app, A);
            if (b?.visible === true && !b.painted) shownBeforePaint = true;
            if (b?.visible === true && hostShownWall === null) hostShownWall = Date.now();
            return b;
          },
          (b) => b?.state === "ready" && b.painted && b.visible,
          10_000,
        );
        const backMs = performance.now() - shown;
        expect(back?.wasCovered, "the host kept no last frame, so the new body stood under no cover").toBe(false);
        expect(shownBeforePaint, "the host showed the new body only once it had painted").toBe(false);
        expect(back, "the card's new body is ready, painted and shown").toMatchObject({ state: "ready", painted: true, visible: true, covered: false });

        // ---- Every frame from the reveal on, by surface colour ----
        const reading = await pollFor(
          () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
          (r) => r.done,
          BURST_MS + 5_000,
        );
        expect(reading.done, "the burst finished").toBe(true);
        const last = reading.frames[reading.frames.length - 1];
        const palette = await readPalette(app, reading.windowBackground, last);
        const after = reading.frames.filter((f) => f.wall >= shownWall);
        expect(after.length, "frames were captured after the reveal").toBeGreaterThan(0);
        const read = after.map((f) => ({ f, classes: classifyFrame(f, palette), columns: gridColumns(f.path, palette.canvas) }));
        const final = read[read.length - 1].classes;
        const pct = (v: number): string => (v * 100).toFixed(2) + "%";
        note(
          `coverless reveal: ${read.length} frames; most grid columns in a frame ${Math.max(...read.map((r) => r.columns))}; ` +
            `worst bare ${pct(Math.max(...read.map((r) => r.classes.bare)))}; final surface ${pct(final.surface)}; shown → painted ${Math.round(backMs)} ms`,
        );
        const floor = read.filter((r) => r.columns >= FLOOR_COLUMNS || r.classes.bare > final.bare + 0.005);
        const faces = await app.evalJS<Array<[number, number]>>("window.__r38nFaces");
        const runs: string[] = [];
        for (const [wall, face] of faces) {
          const label = face === 1 ? "face" : face === 0 ? "no face" : "no placeholder";
          const at = Math.round(wall - shownWall);
          if (runs.length === 0 || !runs[runs.length - 1].startsWith(label + " ")) runs.push(`${label} from ${at} ms`);
        }
        note(`the shell's frames: ${runs.join(", ")}; the host had the body shown by ${hostShownWall === null ? "?" : Math.round(hostShownWall - shownWall)} ms`);
        if (floor.length > 0) {
          note(`frames showing the floor: ${floor.map((r) => `${Math.round(r.f.wall - shownWall)} ms (${r.columns} grid columns, bare ${pct(r.classes.bare)})`).join(", ")}`);
        }
        expect(floor.length, "no frame after the reveal shows the floor's grid or the bare window through the pane").toBe(0);
        expect(final.surface, "the finished rect is the body's own surface").toBeGreaterThan(0.3);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

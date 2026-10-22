/**
 * row-38-evicted.test.ts — a card whose body was evicted under memory
 * pressure comes back as an arrival when it is shown, with nothing of the
 * canvas or the bare window at any frame, and with its draft and its turns.
 *
 * Two Session cards share a pane. The second resumes a transcript of plain
 * turns and takes a draft in its composer, saved to the run's tugbank file;
 * then the first tab is chosen, so the second stands behind it as a sibling,
 * still painting. Critical pressure — the host's stand-in for the dispatch
 * source — evicts every body not placed visible, the sibling and the spare
 * with them: the sibling's page writes its card's state, the host keeps its
 * last frame, and the view goes. Choosing the second tab again asks for its
 * body, cold since critical pressure leaves no spare, and the host stands the
 * last frame over it until the new page paints.
 *
 * From the tab's choosing every composited frame of the pane is read for the
 * floor (row 1's bar): no frame shows the canvas or the bare window through
 * the pane. The floor is told by its grid — full-height columns of grid paint
 * at the cell's pitch — and not by the canvas colour's share, because a
 * Session card's own restore lid and a picker's empty body are dark surfaces
 * within the composite tolerance of the canvas, which a share reads as floor.
 * The body is back ready and painted, its transcript
 * settled with the last turn in it and its composer holding the draft, and the
 * time from the choosing to its own first paint is the row's cold reading.
 *
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-cards-store.ts
 * @covers tugapp/Sources/BodyViewController.swift
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { claudeProjectDir } from "../_harness/claude-home";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankRead } from "../_harness/tugbank-helpers";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { bodyOf, composerText, focusBody, pollFor } from "./_bodies";
import { decodePngFile } from "../_harness/png";
import { classifyFrame, near, readPalette, type Rgb } from "./_frames";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const A = "r38-a";
const B = "r38-b";
const TURNS = 50;
const DRAFT = "row38 draft before the eviction";
const LAST_TURN = `Turn ${TURNS}: the last reading`;
const CARDSTATE = "dev.tugapp.deck.cardstate";
const BURST_MS = 2_000;
const BURST_INTERVAL_MS = 33;
/** Within this of the canvas a pixel is the canvas itself (`_frames.ts`). */
const TOLERANCE = 8;
/** How far from the canvas a pixel may lie and still be grid paint (`floor-host.test.ts`). */
const GRID_REACH = 44;
/** A frame with this many grid columns is showing the floor: a body's chrome draws at most a rule or two. */
const FLOOR_COLUMNS = 3;

/**
 * The full-height runs of grid paint in a frame: columns whose pixels are
 * mostly neither the canvas nor far from it. The floor draws one every cell;
 * a card draws none, or a stray rule.
 */
function gridColumns(path: string, canvas: Rgb): number {
  const png = decodePngFile(path);
  let runs = 0;
  let on = false;
  for (let x = 0; x < png.width; x++) {
    let hits = 0;
    for (let y = 0; y < png.height; y += 2) {
      const i = (y * png.width + x) * 4;
      const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
      if (!near(p, canvas, TOLERANCE) && near(p, canvas, GRID_REACH)) hits += 1;
    }
    const line = hits / Math.ceil(png.height / 2) > 0.5;
    if (line && !on) runs += 1;
    on = line;
  }
  return runs;
}

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: B, componentId: "session", title: "B", closable: true },
    ],
    panes: [
      {
        id: "r38-pane",
        position: { x: 40, y: 40 },
        size: { width: 640, height: 480 },
        cardIds: [A, B],
        activeCardId: B,
        title: "",
        acceptsFamilies: ["maker"],
        slot: 0,
      },
    ],
    activePaneId: "r38-pane",
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** A session JSONL of `turns` plain turns, in claude's own line shape. */
function sessionJsonl(cwd: string, sessionId: string, turns: number): string {
  const base = { isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.105", gitBranch: "main" };
  const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  const t0 = Date.now() - turns * 20_000 - 600_000;
  const lines: unknown[] = [];
  let parent: string | null = null;
  for (let i = 0; i < turns; i++) {
    const user = uuid(i * 2 + 1);
    const assistant = uuid(i * 2 + 2);
    const heading = i === turns - 1 ? LAST_TURN : `Turn ${i + 1}: a reading`;
    lines.push({
      ...base,
      parentUuid: parent,
      type: "user",
      uuid: user,
      timestamp: new Date(t0 + i * 20_000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `Read it again, turn ${i + 1}.` }] },
    });
    lines.push({
      ...base,
      parentUuid: user,
      type: "assistant",
      uuid: assistant,
      timestamp: new Date(t0 + i * 20_000 + 9_000).toISOString(),
      message: {
        id: `msg-r38-${i}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: `### ${heading}\n\nThe walk took ${(i * 7) % 23 + 1} ms, and the cache held ${120 + ((i * 37) % 900)} rows.` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1_000 + i * 300, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    parent = assistant;
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** In the body: whether its transcript is settled with the last turn in it. */
const SETTLED_WITH_LAST = `(function () {
  try {
    if (!window.__tug.sessionSettled(${JSON.stringify(B)})) return false;
    var t = document.querySelector('[data-testid="session-card-transcript"]');
    return t !== null && (t.textContent || "").indexOf(${JSON.stringify(LAST_TURN)}) >= 0;
  } catch (e) { return false; }
})()`;

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

describe.skipIf(!SHOULD_RUN)("body-grounding row 38: the evicted body", () => {
  test(
    "a sibling evicted under critical pressure comes back when its tab is chosen, holding row 1's bar, with its draft and its turns",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r38-project-")));
      const fixtureDir = claudeProjectDir(projectDir);
      mkdirSync(fixtureDir, { recursive: true });
      onTestRunEnd(() => {
        rmSync(projectDir, { recursive: true, force: true });
        rmSync(fixtureDir, { recursive: true, force: true });
      });
      const sid = "a7c0d1ea-0038-4000-8000-000000000050";
      writeFileSync(join(fixtureDir, `${sid}.jsonl`), sessionJsonl(projectDir, sid, TURNS));
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const app = await launchTugApp({
        testName: "body-grounding-row-38-evicted",
        persistInTestMode: true,
        restoreInTestMode: true,
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: B });
        await pollFor(() => bodyOf(app, B), (b) => b?.state === "ready" && b.visible, 30_000);

        // ---- A resumed transcript and a draft, saved ----
        await app.spawnSessionResume(B, { tugSessionId: sid, projectDir });
        await app.body(B).waitForCondition<boolean>(SETTLED_WITH_LAST, { timeoutMs: 30_000 });
        await focusBody(app, B, { composer: true });
        await app.nativeType(DRAFT);
        await pollFor(() => app.body(B).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
        const saved = await pollFor(
          async () => JSON.stringify(tugbankRead<unknown>(tugbankPath, CARDSTATE, B)?.value ?? null),
          (bag) => bag.includes(DRAFT),
          10_000,
        );
        expect(saved, "the draft is in the card's bag on disk before the eviction").toContain(DRAFT);

        // ---- The first tab chosen: the second stands behind it, painting ----
        await app.body(B).click(`[data-testid="tug-tab-${A}"]`);
        await pollFor(() => bodyOf(app, A), (b) => b?.state === "ready" && b.visible, 10_000);
        const sibling = await pollFor(() => bodyOf(app, B), (b) => b !== null && !b.visible && b.shown, 5_000);
        expect(sibling, "the second card stands behind the first as a sibling, still painting").toMatchObject({ visible: false, shown: true });
        const rect = await pollFor(() => placeholderRect(app, A), (r) => r !== null, 5_000);
        expect(rect, "the pane's placeholder has a box").not.toBeNull();

        // ---- Critical pressure takes the sibling and the spare ----
        await app.simulateMemoryPressure("critical");
        const gone = await pollFor(
          () => app.bodies(),
          (all) => !all.some((b) => b.cardId === B) && !all.some((b) => b.cardId === null),
          5_000,
        );
        expect(gone.some((b) => b.cardId === B), "the sibling's body is evicted").toBe(false);
        expect(gone.some((b) => b.cardId === null), "the spare is evicted with it").toBe(false);
        expect((await bodyOf(app, A))?.visible, "the shown card keeps its body").toBe(true);

        // ---- The second tab chosen: an arrival under the last frame ----
        const inset = 4;
        const crop = { x: rect!.x + inset, y: rect!.y + inset, width: rect!.width - 2 * inset, height: rect!.height - 2 * inset };
        await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
        const choseWall = Date.now();
        const chose = performance.now();
        await app.body(A).click(`[data-testid="tug-tab-${B}"]`);
        const covered = await pollFor(() => bodyOf(app, B), (b) => b !== null && (b.covered || b.painted), 3_000);
        const back = await pollFor(() => bodyOf(app, B), (b) => b?.state === "ready" && b.painted && b.visible && !b.covered, 10_000);
        const coldMs = performance.now() - chose;
        expect(covered?.covered, "the body made to bring the card back stood under its last frame").toBe(true);
        expect(back, "the card's new body is ready, painted and shown, its cover gone").toMatchObject({ state: "ready", painted: true, visible: true, covered: false });
        expect(back?.start, "with no spare under critical pressure the new body is made cold").toBe("cold");
        await app.body(B).waitForCondition<boolean>(SETTLED_WITH_LAST, { timeoutMs: 10_000 });
        const settledMs = performance.now() - chose;
        const draft = await pollFor(() => app.body(B).evalJS<string | null>(composerText), (t) => t?.includes(DRAFT) === true, 5_000);
        expect(draft, "the new body's composer holds the draft").toContain(DRAFT);

        // ---- Every frame from the choosing on, by surface colour ----
        const reading = await pollFor(
          () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
          (r) => r.done,
          BURST_MS + 5_000,
        );
        expect(reading.done, "the burst finished").toBe(true);
        const last = reading.frames[reading.frames.length - 1];
        const palette = await readPalette(app, reading.windowBackground, last);
        const after = reading.frames.filter((f) => f.wall >= choseWall);
        expect(after.length, "frames were captured after the tab was chosen").toBeGreaterThan(0);
        const read = after.map((f) => ({ f, classes: classifyFrame(f, palette), columns: gridColumns(f.path, palette.canvas) }));
        const final = read[read.length - 1].classes;
        const pct = (v: number): string => (v * 100).toFixed(2) + "%";
        note(
          `evicted reveal: ${read.length} frames; most grid columns in a frame ${Math.max(...read.map((r) => r.columns))}; ` +
            `worst bare ${pct(Math.max(...read.map((r) => r.classes.bare)))}; final surface ${pct(final.surface)}; ` +
            `cold: chosen → painted ${Math.round(coldMs)} ms, → settled with the last turn ${Math.round(settledMs)} ms; body ready ${back?.readyMs?.toFixed(0)} ms`,
        );
        const floor = read.filter((r) => r.columns >= FLOOR_COLUMNS || r.classes.bare > final.bare + 0.005);
        if (floor.length > 0) {
          note(`frames showing the floor: ${floor.map((r) => `${Math.round(r.f.wall - choseWall)} ms (${r.columns} grid columns, bare ${pct(r.classes.bare)})`).join(", ")}`);
        }
        expect(floor.length, "no frame after the choosing shows the floor's grid or the bare window through the pane").toBe(0);
        expect(final.surface, "the finished rect is the body's own surface").toBeGreaterThan(0.3);
      } finally {
        await app.simulateMemoryPressure("normal").catch(() => undefined);
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0817-stage-cut-judge.test.ts — a workspace switch is one cut, made by the
 * host, whatever the pages are doing.
 *
 * Two workspaces: `from` on a dark theme with one Text card one-up, `to` on a
 * light theme with two Text cards two-up, each with the five rail cards of a
 * user-shaped deck. Once every page has been shown and painted, the shell page
 * and every card's page are stalled to one common wall-clock deadline two
 * seconds out, and the switch is made from the host's own Window-menu row,
 * which runs on the host's main thread where no stall reaches. A burst of
 * window captures every 16 ms reads what the user sees from the gesture on.
 *
 * "frames": every frame is wholly the departed workspace (every probe dark) or
 * wholly the arrived one (every probe light, and each arriving card's interior
 * not the arriving canvas — a card, not a hole); no frame mixes the two, the
 * first arrived frame lands within 50 ms of the gesture, and no departed frame
 * follows it. Probes: points of ground in neither workspace's panes, a point
 * inside each card's pane, and a point in the second arriving card that is
 * ground in the departed workspace where there is one.
 *
 * "rail": the rail's host containers before and after the cut are the same
 * cards at the same frames, and the host's per-frame layer sampler shows none
 * of them hidden or at opacity 0 across it.
 *
 * @covers tugapp/Sources/BodyStages.swift
 * @covers tugdeck/src/deck-manager.ts
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import type { BodyLayerRow, BodyLayersReading, BodyViewSnapshot, CaptureBurstReading } from "./_harness/client";
import { decodePngFile, type DecodedPng } from "./_harness/png";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "./_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "./body-grounding/_bodies";
import { paneRect, type Rect } from "./body-grounding/_row-44";
import { cardsOf, layoutOf, RAIL, space, type Space } from "./readings/_workspace-deck";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
const STALL_MS = 2_000;
const BURST_MS = 1_000;
const BURST_INTERVAL_MS = 16;
const LAYERS_MS = 2_600;
const CUT_BAR_MS = 50;
/** A channel this close to the arriving canvas's reads as the canvas: a hole, not a card. */
const NEAR = 8;
/** Relative luminance at or above this reads light; below it, dark. */
const LIGHT = 0.5;
const PANE_MARGIN = 4;

const FROM: Space = space("g817", "from", ["text"]);
const TO: Space = space("g817", "to", ["text", "text"]);
const RAIL_KINDS = new Set<string>(RAIL.map((r) => r.kind));

/** In a page: spin its main thread until the wall clock reaches `end`, after this eval has answered. */
const stallUntil = (end: number): string => `(function () { setTimeout(function () { while (Date.now() < ${end}) {} }, 0); return true; })()`;

interface Probe {
  name: string;
  /** Viewport points. */
  x: number;
  y: number;
  /** An arriving card's interior: in an arrived frame it must not read as the arriving canvas. */
  toCard: boolean;
}

type Kind = "from" | "to" | "mixed";

interface Reading {
  classes: { wall: number; kind: Kind; detail: string }[];
  gestureWall: number | null;
  firstTo: number | null;
  railBefore: BodyViewSnapshot[];
  railAfter: BodyViewSnapshot[];
  layerRows: BodyLayerRow[];
}

let reading: Reading | null = null;

const lum = (img: DecodedPng, i: number): number => (0.2126 * img.rgba[i] + 0.7152 * img.rgba[i + 1] + 0.0722 * img.rgba[i + 2]) / 255;
const hex = (img: DecodedPng, i: number): string => `#${[0, 1, 2].map((k) => img.rgba[i + k].toString(16).padStart(2, "0")).join("")}`;
const inside = (r: Rect, x: number, y: number, m = 0): boolean => x >= r.x - m && x < r.x + r.width + m && y >= r.y - m && y < r.y + r.height + m;

async function paneRects(app: Parameters<typeof paneRect>[0], ids: readonly string[]): Promise<Map<string, Rect>> {
  const out = new Map<string, Rect>();
  for (const id of ids) {
    const r = await settleFor(() => paneRect(app, id), (x) => x !== null, 5_000);
    if (r !== null) out.set(id, r);
  }
  return out;
}

async function activate(app: Awaited<ReturnType<typeof launchTugApp>>, row: number, spaceId: string): Promise<void> {
  await app.performMenuItem(`window.space.${row}`);
  const active = await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === spaceId, 10_000);
  expect(active, `the warm-up switch reaches ${spaceId}`).toBe(spaceId);
}

async function ready(app: Awaited<ReturnType<typeof launchTugApp>>, s: Space): Promise<void> {
  for (const id of cardsOf(s)) {
    const b = await settleFor(() => bodyOf(app, id), (x) => x?.state === "ready" && x.painted === true, 30_000);
    expect(b?.painted, `${id}: ready and painted`).toBe(true);
  }
}

describe.skipIf(!SHOULD_RUN)("at0817 — the stage cut judge", () => {
  test(
    "frames: with every page stalled, the switch is one cut within the bar",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const layout = layoutOf([FROM, TO]) as { spaces: Record<string, unknown>[] };
      layout.spaces[0].theme = "ironclad";
      layout.spaces[1].theme = "sloop";
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layout));
      const app = await launchTugApp({
        testName: "at0817-stage-cut-judge",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        // Show every page once, so the arriving pages are current at the cut.
        await ready(app, FROM);
        const fromPanes = await paneRects(app, cardsOf(FROM));
        await activate(app, 1, TO.id);
        await ready(app, TO);
        const toPanes = await paneRects(app, cardsOf(TO));
        await activate(app, 0, FROM.id);
        await ready(app, FROM);
        await Bun.sleep(400);

        const width = await app.evalJS<number>("window.innerWidth");
        const height = await app.evalJS<number>("window.innerHeight");
        const panes = [...fromPanes.values(), ...toPanes.values()];
        const content = (s: Space, m: Map<string, Rect>) => s.content.map((c) => m.get(c.id)).filter((r): r is Rect => r !== undefined);
        const fromContent = content(FROM, fromPanes);
        const toContent = content(TO, toPanes);
        note(`from panes: ${fromContent.map((r) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`).join("; ")}`);
        note(`to panes: ${toContent.map((r) => `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`).join("; ")}`);

        // Probes, in viewport points.
        const probes: Probe[] = [];
        const lo = Math.min(...[...fromContent, ...toContent].map((r) => r.x));
        const hi = Math.max(...[...fromContent, ...toContent].map((r) => r.x + r.width));
        const ground: Probe[] = [];
        for (let y = 20; y < height - 20 && ground.length < 6; y += 37) {
          for (let x = lo; x < hi && ground.length < 6; x += 23) {
            if (panes.some((r) => inside(r, x, y, PANE_MARGIN))) continue;
            ground.push({ name: `ground ${Math.round(x)},${Math.round(y)}`, x, y, toCard: false });
          }
        }
        probes.push(...ground);
        for (const [i, r] of fromContent.entries()) probes.push({ name: `from card ${i}`, x: r.x + 20, y: r.y + 40, toCard: false });
        for (const [i, r] of toContent.entries()) probes.push({ name: `to card ${i}`, x: r.x + 20, y: r.y + 40, toCard: true });
        const second = toContent[1];
        if (second !== undefined) {
          let found: Probe | null = null;
          for (let y = second.y + 50; y < second.y + second.height - 10 && found === null; y += 17) {
            for (let x = second.x + 30; x < second.x + second.width - 10 && found === null; x += 17) {
              if (!fromContent.some((r) => inside(r, x, y, PANE_MARGIN))) found = { name: "to card 1, ground in from", x, y, toCard: true };
            }
          }
          if (found !== null) probes.push(found);
          else note("the second arriving card's rect holds no ground of the departed workspace: no such probe");
        }
        note(`probes: ${probes.map((p) => p.name).join(", ")}`);

        const railBefore = (await app.bodies()).filter((b) => b.visible && b.componentId !== null && RAIL_KINDS.has(b.componentId));

        // Stall every page to one deadline, then switch from the host's own menu row.
        const dir = join(tmpdir(), `at0817-${Date.now()}`);
        mkdirSync(dir, { recursive: true });
        const end = Date.now() + STALL_MS;
        const pages = [...cardsOf(FROM), ...cardsOf(TO)];
        await Promise.all([
          app.evalJS<boolean>(stallUntil(end)),
          ...pages.map((id) => app.body(id).evalJS<boolean>(stallUntil(end)).catch(() => false)),
        ]);
        await Bun.sleep(100);
        await app.bodyLayers({ op: "arm", windowMs: LAYERS_MS });
        await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop: { x: 0, y: 0, width, height }, outDir: dir });
        await app.captureBurst({ op: "mark", name: "gesture" });
        await app.performMenuItem("window.space.1");
        const frames = (await settleFor(
          () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
          (x) => x.done,
          BURST_MS + 10_000,
        )) as CaptureBurstReading;
        note(`stall ends ${end - Date.now()} ms after the burst was read`);

        // After the stall: the switch lands, and the rail is read again.
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === TO.id, 15_000);
        const layers = (await settleFor(
          () => app.bodyLayers({ op: "read" }) as Promise<BodyLayersReading>,
          (x) => x.done === true,
          LAYERS_MS + 10_000,
        )) as BodyLayersReading;
        await Bun.sleep(300);
        const railAfter = (await app.bodies()).filter((b) => b.visible && b.componentId !== null && RAIL_KINDS.has(b.componentId));

        // Classify every frame from the gesture's mark on.
        const markIndex = frames.marks.gesture;
        const markFrame = frames.frames.find((f) => f.index === markIndex) ?? null;
        const gestureWall = markFrame?.wall ?? null;
        const scale = frames.scale;
        const classes: Reading["classes"] = [];
        let toCanvas: string | null = null;
        for (const f of frames.frames.filter((x) => markIndex === undefined || x.index >= markIndex)) {
          const img = decodePngFile(f.path);
          const reads = probes.map((p) => {
            const px = Math.min(img.width - 1, Math.max(0, Math.round(p.x * scale)));
            const py = Math.min(img.height - 1, Math.max(0, Math.round(p.y * scale)));
            const i = (py * img.width + px) * 4;
            return { p, i, light: lum(img, i) >= LIGHT, hex: hex(img, i) };
          });
          let kind: Kind;
          if (reads.every((r) => !r.light)) kind = "from";
          else if (reads.every((r) => r.light)) {
            const groundRead = reads.find((r) => !r.p.toCard && r.p.name.startsWith("ground"));
            toCanvas ??= groundRead?.hex ?? null;
            const holes = reads.filter((r) => {
              if (!r.p.toCard || groundRead === undefined) return false;
              return [0, 1, 2].every((k) => Math.abs(img.rgba[r.i + k] - img.rgba[groundRead.i + k]) <= NEAR);
            });
            kind = holes.length === 0 ? "to" : "mixed";
          } else kind = "mixed";
          classes.push({ wall: f.wall, kind, detail: reads.map((r) => `${r.p.name}=${r.hex}`).join(" ") });
        }
        const firstTo = classes.find((c) => c.kind === "to")?.wall ?? null;
        reading = { classes, gestureWall, firstTo, railBefore, railAfter, layerRows: layers.rows };

        for (const c of classes) note(`${gestureWall === null ? "?" : Math.round(c.wall - gestureWall)} ms: ${c.kind}${c.kind === "mixed" ? ` (${c.detail})` : ""}`);
        note(`arriving canvas read as ${toCanvas ?? "never seen"}`);
        note(`gesture → first arrived frame: ${firstTo === null || gestureWall === null ? "no arrived frame in the burst" : `${Math.round(firstTo - gestureWall)} ms`}`);

        expect(gestureWall, "the burst stamped the gesture's mark").not.toBeNull();
        expect(firstTo, `an arrived frame within the ${BURST_MS} ms burst (none: the cut waited on a stalled page)`).not.toBeNull();
        expect(classes.filter((c) => c.kind === "mixed").length, "no frame mixes the two workspaces").toBe(0);
        expect(Math.round((firstTo ?? Infinity) - (gestureWall ?? 0)), `the first arrived frame within ${CUT_BAR_MS} ms of the gesture`).toBeLessThanOrEqual(CUT_BAR_MS);
        expect(classes.filter((c) => firstTo !== null && c.wall > firstTo && c.kind === "from").length, "no departed frame after the first arrived one").toBe(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test("rail: the rail's containers neither move nor hide across the cut", () => {
    expect(reading, "the frames test took the reading").not.toBeNull();
    const r = reading as Reading;
    const shape = (xs: readonly BodyViewSnapshot[]): string[] =>
      xs.map((b) => `${b.cardId} ${Math.round(b.frame.x)},${Math.round(b.frame.y)} ${Math.round(b.frame.width)}x${Math.round(b.frame.height)}`).sort();
    note(`rail before: ${shape(r.railBefore).join("; ")}`);
    note(`rail after: ${shape(r.railAfter).join("; ")}`);
    const ids = new Set(r.railBefore.map((b) => b.cardId));
    const dark = r.layerRows.filter((row) => ids.has(row.cardId) && (row.hidden || row.opacity === 0));
    const darkCards = [...new Set(dark.map((row) => row.cardId))];
    note(`rail containers hidden or transparent across the cut: ${darkCards.length === 0 ? "none" : darkCards.join(", ")}`);
    expect(r.railBefore.length, "the departed workspace showed its rail").toBeGreaterThan(0);
    expect(shape(r.railAfter), "the same rail cards at the same frames after the cut").toEqual(shape(r.railBefore));
    expect(darkCards, "no rail container hidden or at opacity 0 across the cut").toEqual([]);
  });
});

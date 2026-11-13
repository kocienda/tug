/**
 * at0814-switch-ground-shell-late.test.ts — the canvas and its grid switch
 * with the workspace, however late the shell's own frame is.
 *
 * The canvas and grid are the shell's page's. On a deck whose shell is slow
 * to present its switched frame, the host's cut showed the arriving cards
 * over the departed workspace's canvas until that frame landed. The host
 * now stands a ground of its own beneath the cards from the cut until the
 * shell's frame has rendered (`BodySwitchGround`).
 *
 * A dark home workspace and a light away one, a Text card each, the away
 * page made ahead. The switch is dispatched and the shell's main thread is
 * then stalled 600 ms in the next task: the commit and its placement are on
 * time and the frame is not. A burst of window captures every 16 ms is read
 * against the frame before the gesture and the settled one, over the pixels
 * the two differ in outside every pane: the canvas (the settled frame's
 * commonest colour there) and the grid lines (any other). Both must read as
 * arrived well inside the stall, and stay arrived to the end — the hand-back
 * from the host's ground to the shell's own must not show.
 *
 * @covers tugapp/Sources/BodyFaceHandOver.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugdeck/src/contexts/theme-provider.tsx
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import type { CaptureBurstReading } from "./_harness/client";
import { decodePngFile, type DecodedPng } from "./_harness/png";
import { bodyOf, pollFor, settleFor } from "./body-grounding/_bodies";
import { ACTIVE_SPACE, paneRect, type Rect } from "./body-grounding/_row-44";
import { AWAY_SPACE, chooseSpaceTheme, HOME_SPACE, launchSkeletonDeck, madeAhead, SHOULD_RUN, TEST_TIMEOUT_MS } from "./skeleton-switch-fixture";

const HOME = "g814-home";
const AWAY = "g814-away";
/** How long the shell's main thread is stalled after the switch's commit. */
const STALL_MS = 600;
/** By when the canvas and grid must have switched: past the bar and its two frames, far inside the stall. */
const SWITCHED_BY_MS = 300;
const FRAMES_MS = 1_800;
const FRAMES_INTERVAL_MS = 16;
/** Two channels within this of each other read as one colour. */
const NEAR = 8;
/** The share of a region's changed pixels that must read as the settled frame's. */
const ARRIVED = 0.95;

const near = (img: DecodedPng, i: number, other: DecodedPng): boolean =>
  Math.abs(img.rgba[i] - other.rgba[i]) <= NEAR &&
  Math.abs(img.rgba[i + 1] - other.rgba[i + 1]) <= NEAR &&
  Math.abs(img.rgba[i + 2] - other.rgba[i + 2]) <= NEAR;

const inside = (x: number, y: number, rects: readonly Rect[]): boolean =>
  rects.some((r) => x >= r.x - 8 && x < r.x + r.width + 8 && y >= r.y - 8 && y < r.y + r.height + 8);

/** The commonest colour among `img`'s pixels outside `panes`, as a key. */
function commonest(img: DecodedPng, panes: readonly Rect[]): string {
  const counts = new Map<string, number>();
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      if (inside(x, y, panes)) continue;
      const i = (y * img.width + x) * 4;
      const key = `${img.rgba[i]},${img.rgba[i + 1]},${img.rgba[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

describe.skipIf(!SHOULD_RUN)("at0814 — the ground switches with the workspace", () => {
  test(
    "with the shell stalled after the switch's commit, the canvas and grid are the arriving workspace's from the cut on",
    async () => {
      const deck = await launchSkeletonDeck("at0814-switch-ground-shell-late", [AWAY], { home: [HOME] });
      const { app } = deck;
      try {
        await chooseSpaceTheme(app, HOME_SPACE, "ironclad");
        await chooseSpaceTheme(app, AWAY_SPACE, "sloop");
        await Bun.sleep(500);
        expect(await madeAhead(app, [AWAY], 15_000), "the away page is made ahead").toBe(true);
        const scale = await app.evalJS<number>("window.devicePixelRatio");
        const toPx = (r: Rect): Rect => ({ x: r.x * scale, y: r.y * scale, width: r.width * scale, height: r.height * scale });
        const homePane = await paneRect(app, HOME);
        const width = await app.evalJS<number>("window.innerWidth");
        const height = await app.evalJS<number>("window.innerHeight");
        const dir = process.env.AT0814_FRAMES_DIR ?? join(tmpdir(), `at0814-${Date.now()}`);
        mkdirSync(dir, { recursive: true });
        await app.captureBurst({ op: "arm", durationMs: FRAMES_MS, intervalMs: FRAMES_INTERVAL_MS, crop: { x: 0, y: 0, width, height }, outDir: dir });
        await Bun.sleep(60);
        // The switch, then the stall in the next task: the commit and its
        // placement have run, and the frame has not been presented.
        const cut = await app.evalJS<number>(
          `(function () {
            var at = Date.now();
            window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(AWAY_SPACE)} });
            setTimeout(function () { var until = performance.now() + ${STALL_MS}; while (performance.now() < until) {} }, 0);
            return at;
          })()`,
        );
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === AWAY_SPACE, 5_000);
        await settleFor(() => bodyOf(app, AWAY), (b) => b?.visible === true && b.painted === true, 5_000);
        const awayPane = await paneRect(app, AWAY);
        const frames = (await settleFor(
          () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
          (x) => x.done,
          FRAMES_MS + 10_000,
        )) as CaptureBurstReading;
        const hold = ((await app.handOvers()).switchHolds ?? []).filter((h) => h.fromWall >= cut - 50).at(-1) ?? null;
        note(`hold: ${hold === null ? "none" : `${Math.round(hold.fromWall - cut)} → ${hold.toWall === null ? "open" : Math.round(hold.toWall - cut)} ms, ${hold.outcome}, shell ${hold.shellMs ?? "none"}`}`);
        const panes = [homePane, awayPane].filter((r): r is Rect => r !== null).map(toPx);
        const before = frames.frames.filter((f) => f.wall < cut).at(-1);
        const settled = frames.frames.at(-1);
        expect(before, "a frame before the gesture").toBeDefined();
        expect(settled, "a settled frame").toBeDefined();
        if (before === undefined || settled === undefined) return;
        const was = decodePngFile(before.path);
        const now = decodePngFile(settled.path);
        const bg = commonest(now, panes);
        const regions: Record<"canvas" | "grid", number[]> = { canvas: [], grid: [] };
        for (let y = 0; y < now.height; y += 1) {
          for (let x = 0; x < now.width; x += 1) {
            if (inside(x, y, panes)) continue;
            const i = (y * now.width + x) * 4;
            if (near(was, i, now)) continue;
            if (`${now.rgba[i]},${now.rgba[i + 1]},${now.rgba[i + 2]}` === bg) regions.canvas.push(i);
            else regions.grid.push(i);
          }
        }
        note(`frames ${frames.frames.length} in ${dir}; changed pixels: canvas ${regions.canvas.length}, grid ${regions.grid.length}`);
        expect(regions.canvas.length, "the two workspaces' canvases differ").toBeGreaterThan(1000);
        expect(regions.grid.length, "the two workspaces' grids differ").toBeGreaterThan(1000);
        const bad: string[] = [];
        const first: Record<string, number | null> = { canvas: null, grid: null };
        const lines: string[] = [];
        for (const f of frames.frames.filter((f) => f.wall >= cut)) {
          const img = decodePngFile(f.path);
          const at = Math.round(f.wall - cut);
          const shares: string[] = [];
          for (const k of ["canvas", "grid"] as const) {
            const px = regions[k];
            const step = Math.max(1, Math.floor(px.length / 4000));
            let arrived = 0;
            let n = 0;
            for (let j = 0; j < px.length; j += step) {
              n += 1;
              if (near(img, px[j], now)) arrived += 1;
            }
            const share = arrived / n;
            shares.push(`${k} ${Math.round(share * 100)}%`);
            if (share >= ARRIVED) first[k] ??= at;
            else if (first[k] !== null) bad.push(`${k}: back to ${Math.round(share * 100)}% arrived at ${at} ms, after it had switched at ${first[k]} ms`);
          }
          lines.push(`${String(at).padStart(5)} ms  ${shares.join("  ")}`);
        }
        note(`first arrived (ms from the gesture): canvas ${first.canvas}, grid ${first.grid}`);
        for (const line of lines.slice(0, 60)) note(line);
        for (const k of ["canvas", "grid"] as const) {
          if (first[k] === null || (first[k] as number) > SWITCHED_BY_MS) {
            bad.push(`${k}: switched ${first[k] === null ? "never" : `at ${first[k]} ms`}, not within ${SWITCHED_BY_MS} ms of the gesture, with the shell stalled ${STALL_MS} ms`);
          }
        }
        expect(bad, "the canvas and grid switch at the cut and stay switched").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

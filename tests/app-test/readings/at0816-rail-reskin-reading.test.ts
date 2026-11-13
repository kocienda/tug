/**
 * at0816-rail-reskin-reading.test.ts — how long a rail card's page takes to
 * re-skin when its workspace's theme changes, read at the window.
 *
 * A shared rail follows the active workspace's theme, so on a switch between
 * workspaces of different themes each rail card is a live page that must
 * re-skin after the host's cut. This reads how long that takes: a user-shaped
 * workspace with its five rail cards and two Text cards, its theme flipped
 * between a dark and a light one six times, a burst of window captures every
 * 16 ms across each flip. For each rail card's pane, the first frame in which
 * 95% of the pixels that differ between the frame before the flip and the
 * settled one read as the settled one's, in ms from the flip. Asserts only
 * that the flips ran: the times are the product.
 *
 * @covers tugdeck/src/contexts/theme-provider.tsx
 * @covers tugdeck/src/theme-links.ts
 * @covers tugdeck/src/body/body-main.ts
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { decodePngFile, type DecodedPng } from "../_harness/png";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, settleFor } from "../body-grounding/_bodies";
import { paneRect, type Rect } from "../body-grounding/_row-44";
import { cardsOf, layoutOf, RAIL, space, type Space } from "./_workspace-deck";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FLIPS = 6;
const FRAMES_MS = 1_500;
const FRAMES_INTERVAL_MS = 16;
const NEAR = 8;
const ARRIVED = 0.95;

const SPACES: Space[] = [space("g816", "home", ["text", "text"]), space("g816", "away", ["text"])];

const near = (img: DecodedPng, i: number, other: DecodedPng): boolean =>
  Math.abs(img.rgba[i] - other.rgba[i]) <= NEAR &&
  Math.abs(img.rgba[i + 1] - other.rgba[i + 1]) <= NEAR &&
  Math.abs(img.rgba[i + 2] - other.rgba[i + 2]) <= NEAR;

function stats(xs: readonly number[]): string {
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  return `median ${Math.round(s[Math.floor((s.length - 1) / 2)])}, max ${Math.round(s[s.length - 1])}`;
}

describe.skipIf(!SHOULD_RUN)("at0816 — a rail card's re-skin", () => {
  test(
    "six theme flips, each rail card's pane timed to its settled colours",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const layout = layoutOf(SPACES) as { spaces: Record<string, unknown>[] };
      for (const s of layout.spaces) s.theme = "ironclad";
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layout));
      const app = await launchTugApp({
        testName: "at0816-rail-reskin-reading",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const home = SPACES[0];
        for (const id of cardsOf(home)) {
          await settleFor(() => bodyOf(app, id), (x) => x?.state === "ready" && x.painted === true, 30_000);
        }
        await Bun.sleep(1_500);
        const scale = await app.evalJS<number>("window.devicePixelRatio");
        const width = await app.evalJS<number>("window.innerWidth");
        const height = await app.evalJS<number>("window.innerHeight");
        const rects: { kind: string; rect: Rect }[] = [];
        for (const [i, r] of RAIL.entries()) {
          const rect = await paneRect(app, home.rail[i]);
          if (rect !== null) rects.push({ kind: r.kind, rect: { x: rect.x * scale, y: rect.y * scale, width: rect.width * scale, height: rect.height * scale } });
        }
        note(`rail panes read: ${rects.map((r) => `${r.kind} ${Math.round(r.rect.width)}x${Math.round(r.rect.height)}`).join(", ")}`);
        const times: Record<string, number[]> = {};
        const canvasTimes: number[] = [];
        for (let flip = 0; flip < FLIPS; flip++) {
          const theme = flip % 2 === 0 ? "sloop" : "ironclad";
          const dir = join(tmpdir(), `at0816-${Date.now()}-${flip}`);
          mkdirSync(dir, { recursive: true });
          await app.captureBurst({ op: "arm", durationMs: FRAMES_MS, intervalMs: FRAMES_INTERVAL_MS, crop: { x: 0, y: 0, width, height }, outDir: dir });
          await Bun.sleep(80);
          const cut = await app.evalJS<number>(
            `(function () { var at = Date.now(); window.__tug.chooseSpaceTheme(${JSON.stringify(home.id)}, ${JSON.stringify(theme)}); return at; })()`,
          );
          const frames = (await settleFor(
            () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
            (x) => x.done,
            FRAMES_MS + 10_000,
          )) as CaptureBurstReading;
          const before = frames.frames.filter((f) => f.wall < cut).at(-1);
          const settled = frames.frames.at(-1);
          if (before === undefined || settled === undefined) continue;
          const was = decodePngFile(before.path);
          const now = decodePngFile(settled.path);
          const regions: { name: string; px: number[] }[] = rects.map((r) => ({ name: r.kind, px: [] }));
          const canvas: number[] = [];
          for (let y = 0; y < now.height; y += 2) {
            for (let x = 0; x < now.width; x += 2) {
              const i = (y * now.width + x) * 4;
              if (near(was, i, now)) continue;
              const at = rects.findIndex((r) => x >= r.rect.x && x < r.rect.x + r.rect.width && y >= r.rect.y && y < r.rect.y + r.rect.height);
              if (at >= 0) regions[at].px.push(i);
              else if (y > now.height - 12 * scale) canvas.push(i);
            }
          }
          const first: Record<string, number | null> = {};
          let canvasFirst: number | null = null;
          for (const f of frames.frames.filter((x) => x.wall >= cut)) {
            const img = decodePngFile(f.path);
            const at = Math.round(f.wall - cut);
            const share = (px: readonly number[]): number => {
              if (px.length === 0) return 0;
              const step = Math.max(1, Math.floor(px.length / 3000));
              let n = 0;
              let ok = 0;
              for (let j = 0; j < px.length; j += step) {
                n += 1;
                if (near(img, px[j], now)) ok += 1;
              }
              return ok / n;
            };
            for (const r of regions) if (first[r.name] == null && share(r.px) >= ARRIVED) first[r.name] = at;
            if (canvasFirst === null && share(canvas) >= ARRIVED) canvasFirst = at;
          }
          if (canvasFirst !== null) canvasTimes.push(canvasFirst);
          for (const r of regions) {
            const t = first[r.name];
            if (t != null) (times[r.name] ??= []).push(t);
          }
          note(
            `flip ${flip + 1} → ${theme}: ${regions.map((r) => `${r.name} ${first[r.name] ?? "never"} (${r.px.length} px)`).join(", ")}; ` +
              `canvas strip ${canvasFirst ?? "never"} (${canvas.length} px)`,
          );
          await Bun.sleep(600);
        }
        for (const [kind, xs] of Object.entries(times)) note(`${kind}: re-skinned ${stats(xs)} ms after the flip (${xs.length}/${FLIPS})`);
        note(`all rail cards: ${stats(Object.values(times).flat())} ms; canvas strip: ${stats(canvasTimes)} ms`);
        expect(Object.values(times).flat().length).toBeGreaterThan(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

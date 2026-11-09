/**
 * at0788-skeleton-face-wave.test.ts — the host's drawn face for an arriving
 * card carries the progress wave's rest frame, so the skeleton the first
 * switched frame shows is already a loading one.
 *
 * Two Text cards on a workspace never shown, both pages made slow. A window
 * capture burst and the host's layer rows run over the switch. In every
 * captured frame in which the host's face stands for a card, the middle of
 * that card's content box must hold the wave's marks: pixels standing off
 * the box's own surface, where a bare lid holds none. The face stands from
 * the cut until the shell's own frame is on screen, so this reads the face
 * and not the stand-in beneath it. The switch runs with the made-ahead path
 * as it ships, cut as soon as home has painted so the away pages are cold.
 *
 * @covers tugapp/Sources/BodyFaceHandOver.swift
 * @covers tugdeck/src/lib/face-draw.ts
 * @covers tugdeck/src/components/chrome/body-stand-in.tsx
 */

import { describe, expect, test } from "bun:test";

import { note } from "./_harness";
import type { CaptureBurstReading } from "./_harness/client";
import { decodePngFile } from "./_harness/png";
import { settleFor } from "./body-grounding/_bodies";
import { near, type Rgb } from "./body-grounding/_frames";
import { contentOf, paneRect, type Rect } from "./body-grounding/_row-44";
import { armLayers, AWAY_SPACE, launchSkeletonDeck, readLayers, SHOULD_RUN, slowPages, switchTo, TEST_TIMEOUT_MS } from "./skeleton-switch-fixture";

const CARDS = ["sk788-a", "sk788-b"];
const SLOW_MS = 1_500;
const BURST_MS = 600;
/** The middle of a content box, in points: where a centred wave stands. */
const MIDDLE = { width: 160, height: 48 };
/** How far from the box's commonest colour a pixel lies to be a mark on it. */
const MARK_REACH = 24;
/** The share of the middle that must be marks for it to hold the wave. */
const MARK_SHARE = 0.01;

type Png = ReturnType<typeof decodePngFile>;

function markShare(png: Png, x0: number, y0: number, x1: number, y1: number): number {
  const counts = new Map<number, number>();
  const px: Rgb[] = [];
  for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x += 1) {
      const i = (y * png.width + x) * 4;
      const p = { r: png.rgba[i], g: png.rgba[i + 1], b: png.rgba[i + 2] };
      px.push(p);
      const key = (p.r << 16) | (p.g << 8) | p.b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let fillKey = 0;
  let most = -1;
  for (const [key, n] of counts) if (n > most) [fillKey, most] = [key, n];
  const fill = { r: (fillKey >> 16) & 255, g: (fillKey >> 8) & 255, b: fillKey & 255 };
  return px.filter((p) => !near(p, fill, MARK_REACH)).length / Math.max(1, px.length);
}

describe.skipIf(!SHOULD_RUN)("at0788 — the face's wave", () => {
  test(
    "every frame the host's face stands for an arriving card shows the wave in its content box",
    async () => {
      const deck = await launchSkeletonDeck("at0788-skeleton-face-wave", CARDS);
      const { app } = deck;
      try {
        await slowPages(app, Object.fromEntries(CARDS.map((id) => [id, SLOW_MS])));
        const width = await app.evalJS<number>("window.innerWidth");
        const height = await app.evalJS<number>("window.innerHeight");
        await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: 8, crop: { x: 0, y: 0, width, height } });
        await armLayers(app, BURST_MS);
        await Bun.sleep(50);
        const cut = await switchTo(app, AWAY_SPACE);
        const reading = (await settleFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000)) as CaptureBurstReading;
        const rows = await readLayers(app, BURST_MS);
        expect(reading.done && rows !== null, "the burst and the layer rows finished").toBe(true);
        const rects: Record<string, Rect> = {};
        for (const id of CARDS) {
          const r = await settleFor(() => paneRect(app, id), (v) => v !== null, 5_000);
          expect(r, `${id} has a pane box`).not.toBeNull();
          rects[id] = r as Rect;
        }
        const s = reading.scale;
        const bad: string[] = [];
        const read: string[] = [];
        let facedFrames = 0;
        for (const f of reading.frames.filter((fr) => fr.wall >= cut)) {
          const png = decodePngFile(f.path);
          for (const id of CARDS) {
            const host = (rows ?? []).filter((r) => r.cardId === id && r.wall <= f.wall).at(-1);
            if (host?.faced !== true) continue;
            facedFrames += 1;
            const c = contentOf(rects[id]);
            const cx = c.x + c.width / 2;
            const cy = c.y + c.height / 2;
            const share = markShare(
              png,
              Math.round((cx - MIDDLE.width / 2) * s),
              Math.round((cy - MIDDLE.height / 2) * s),
              Math.round((cx + MIDDLE.width / 2) * s),
              Math.round((cy + MIDDLE.height / 2) * s),
            );
            const ms = Math.round(f.wall - cut);
            read.push(`${id} ${ms} ms ${(share * 100).toFixed(2)}%`);
            if (share < MARK_SHARE) bad.push(`${id} at ${ms} ms: its face's content box holds ${(share * 100).toFixed(2)}% marks, no wave`);
          }
        }
        note(`faced frames read: ${facedFrames}; middle marks ${read.join("; ") || "none"}`);
        expect(facedFrames, "the host stood a face for an arriving card in at least one captured frame").toBeGreaterThan(0);
        expect(bad, "every faced frame carries the wave's rest frame").toEqual([]);
      } finally {
        await deck.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0785-image-crossing-hangs-centered.test.ts — an image card whose height
 * changes hangs its picture from the box's center.
 *
 * An image card centers its picture in its box. While a whole card's height
 * crosses, the host shows the old frame's snapshot over the page laid out at
 * the new size, and a card naming no split held that snapshot at the top: the
 * old centering stood over the new one, the two meeting at the cover's edge,
 * and splitting a column with an image in it broke the picture in two.
 *
 * The image card's scroller now says its content is centered
 * (`data-crossing-scroller="center"`), the solved page names the scroller's
 * top and its ground beside the split (`lib/crossing-band.ts`), and the host
 * rides the page's scroller on the box's center between the cover's head and
 * its tail (`BodyBeatsRunner.rideCenter`). This file splits a stacked slot
 * holding an image card and reads the crossing the host carried it on: a
 * split with a center, the head ending at the scroller's top.
 *
 * The ride's arithmetic is `BodyBeatsTests.testACenteredSplitRidesItsScrollerOnTheBoxCenter`.
 *
 * @covers tugdeck/src/lib/crossing-band.ts
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/components/tugways/cards/file-view-card.tsx
 * @covers tugapp/Sources/BodyBeatsRunner.swift
 * @covers tugapp/Sources/BodyBeats.swift
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { launchTugApp, note } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import {
  AFTER_LAND_MS,
  RAIL_WIDTH,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  deckShape,
  setColumnMode,
  splitFrameCount,
  wait,
} from "./column-split-fixture";

const FIGURE = '[data-slot="file-view-card"] [data-slot="image-body"]';

/** CRC-32, the flavour PNG chunks carry. */
function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC over type+data. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A real opaque RGBA PNG, square, so a fitted picture is centered with room above and below. */
function encodePng(size: number): Buffer {
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 4);
    for (let x = 0; x < size; x += 1) {
      const px = row + 1 + x * 4;
      raw[px] = 40;
      raw[px + 1] = 120;
      raw[px + 2] = 220;
      raw[px + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The crossing account the host keeps of a body's last crossing (`CrossingAccount.json`). */
interface CrossingAccount {
  planId: number;
  cover: string | null;
  solved?: boolean;
  split: { splitY: number; follows: boolean; centerY: number | null } | null;
}

describe.skipIf(!SHOULD_RUN)("at0785 — an image card's crossing hangs from its center", () => {
  test(
    "splitting a slot carries the image card on a centered split",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0785-image-"));
      const file = path.join(dir, "square.png");
      fs.writeFileSync(file, encodePng(64));

      const app = await launchTugApp({ testName: "at0785-image-crossing-hangs-centered" });
      try {
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue("dev.tugapp.layout", "widthPx", { kind: "i64", value: ${RAIL_WIDTH} }), null)`,
        );
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p4"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(AFTER_LAND_MS);

        const viewer = kindBody(app, "file-view");
        await app.dispatchControlAction("open-file", { path: file });
        await viewer.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIGURE)}) !== null`,
          { timeoutMs: 20_000 },
        );
        expect(
          await viewer.evalJS<string | null>(
            `document.querySelector('[data-slot="file-view-card"]').getAttribute("data-crossing-scroller")`,
          ),
          "the image card's scroller says its content is centered",
        ).toBe("center");
        await wait(AFTER_LAND_MS);

        // The viewer opened into the focused card's slot, stacked over its
        // members: split it, and every member's height crosses.
        const slot = await app.evalJS<number | null>(
          `(function () {
            var s = window.tugdeck.diag.getDeckState();
            var card = s.cards.find(function (c) { return c.componentId === "file-view"; });
            var pane = card && s.panes.find(function (p) { return p.cardIds.indexOf(card.id) !== -1; });
            return pane && typeof pane.slot === "number" ? pane.slot : null;
          })()`,
        );
        note("viewer slot", slot);
        expect(slot, "the viewer stands in a numbered slot").not.toBeNull();
        await setColumnMode(app, slot as number, "split");
        expect(await splitFrameCount(app), "the slot is split").toBeGreaterThanOrEqual(2);

        const body = (await app.bodies()).find((b) => b.componentId === "file-view");
        const crossing = (body as unknown as { crossing: CrossingAccount | null } | undefined)?.crossing ?? null;
        note("viewer crossing", crossing);
        expect(crossing, "the split carried the viewer on a crossing").not.toBeNull();
        expect(crossing?.cover, "under a cover of its last frame").toBe("snapshot");
        const split = crossing?.split ?? null;
        expect(split, "the solved page named where its picture splits").not.toBeNull();
        expect(split?.follows).toBe(false);
        expect(split?.centerY, "and that its scroller rides the box's center").not.toBeNull();
        expect(split!.centerY!, "the head ends above the split").toBeLessThan(split!.splitY);
        expect(split!.centerY!, "below the card's masthead").toBeGreaterThan(0);
      } finally {
        await app.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});

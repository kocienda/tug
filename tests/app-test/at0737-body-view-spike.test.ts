/**
 * at0737-body-view-spike.test.ts — does a page in a web view of its own keep
 * its frames while the deck's main thread is stalled?
 *
 * The per-card web views program rests on one premise: a card whose content
 * runs in its own WKWebView, in its own WebContent process, holds display
 * rate whatever the deck's page is doing. This file reads that premise before
 * anything is built on it. The `spikeBody` verb places one child page
 * (`/?body=spike`, which animates and paints a log line every frame) in a
 * WKWebView beneath the deck, shown through a hole cut in the deck's paint,
 * then stalls the deck with a three-second synchronous loop and takes three
 * readings over it:
 *
 *  (a) the child's own rAF ticks — its frame production;
 *  (b) the host display link sampling the child container's presentation
 *      layer while a Core Animation translate runs on it — the render
 *      server's;
 *  (c) composited window captures cropped to the child — the window's truth.
 *
 * Beside them, before the stall: (d) the child shows through the deck in a
 * composited capture, and (e) a native click inside the child's rect reaches
 * the child, not the deck. The WebContent processes and their resident size
 * are read off `ps` before and after the child exists, and every number is
 * noted for the program brief's record.
 *
 * @foreground — WebKit suspends rAF in a covered window, and display rate is
 * the whole of what is read, so the launch takes the screen.
 *
 * @motion
 * @covers tugapp/Sources/HostFrameMeter.swift
 * @covers tugapp/Sources/FrameMeterStats.swift
 * @covers tugapp/Sources/TestHarness/SpikeBodyHandlers.swift
 * @covers tugdeck/src/body/spike-page.ts
 * @covers tugdeck/src/entry.ts
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import { decodePngFile } from "./_harness/png";

const TEST_NAME = "at0737-body-view-spike";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const STALL_MS = 3000;
const TRANSLATE_PX = 120;

/** The spike page's background, `#1d2733`. */
const SPIKE_BG = [0x1d, 0x27, 0x33] as const;
/** Per-channel slack for a composited capture's color conversion. */
const COLOR_SLACK = 18;

/** Where the composite capture is kept, outside the harness's sweep. */
const CAPTURE_COPY = "/tmp/at0737-composite.png";

interface WebContentProcess {
  pid: number;
  rssKb: number;
}

/** Every WebContent process on the machine, with its resident size. */
function webContentProcesses(): WebContentProcess[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,rss=,comm="]).stdout.toString();
  const found: WebContentProcess[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m && m[3].includes("com.apple.WebKit.WebContent")) {
      found.push({ pid: Number(m[1]), rssKb: Number(m[2]) });
    }
  }
  return found;
}

describe.skipIf(!SHOULD_RUN)("at0737: a child web view holds display rate under a stalled deck", () => {
  test(
    "the spike's reading meets the bar",
    async () => {
      const app = await launchTugApp({ foreground: true, testName: TEST_NAME });
      try {
        const before = webContentProcesses();
        const created = await app.spikeCreate();
        const after = webContentProcesses();
        const beforePids = new Set(before.map((p) => p.pid));
        const added = after.filter((p) => !beforePids.has(p.pid));
        note("spike cold ms", Math.round(created.coldMs));
        note("WebContent processes before / after", `${before.length} / ${after.length}`);
        note("WebContent processes the child added (pid, rss MB)", added.map((p) => [p.pid, Math.round(p.rssKb / 1024)]));
        expect(added.length).toBeGreaterThanOrEqual(1);

        const { frame } = created;

        // What the deck has at the child's centre once the hole is cut — read
        // before the capture, so a capture that shows the deck says which of
        // its elements still paints there.
        const cx = frame.x + frame.width / 2;
        const cy = frame.y + frame.height / 2;
        note(
          "deck at the child's centre",
          await app.evalJS<unknown>(`(() => ({
            hole: document.getElementById("tug-spike-hole") !== null,
            html: getComputedStyle(document.documentElement).backgroundColor,
            body: getComputedStyle(document.body).backgroundColor,
            bodyClip: getComputedStyle(document.body).clipPath.slice(0, 60),
            under: document.elementsFromPoint(${cx}, ${cy}).slice(0, 6).map((e) =>
              e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") +
              (typeof e.className === "string" && e.className ? "." + e.className.split(" ")[0] : "") +
              " bg=" + getComputedStyle(e).backgroundColor),
          }))()`),
        );

        // (d) The child shows through the deck: the composited window, at a
        // point inside the child clear of its log text, is the child's paint.
        const shot = await app.captureWindow();
        // Kept past the harness's sweep at quit: the composite is the record
        // a reader of this reading looks at.
        copyFileSync(shot.path, CAPTURE_COPY);
        note("composite kept at", CAPTURE_COPY);
        const png = decodePngFile(shot.path);
        const scale = shot.width / shot.contentWidth;
        const titleBarPx = shot.height - shot.contentHeight * scale;
        const pixelAt = (x: number, y: number): number[] => {
          const px = Math.round(x * scale);
          const py = Math.round(titleBarPx + y * scale);
          const i = (py * png.width + px) * 4;
          return [png.rgba[i], png.rgba[i + 1], png.rgba[i + 2]];
        };
        const inside = pixelAt(frame.x + frame.width - 24, frame.y + frame.height - 24);
        note("composited pixel inside the child", inside);
        note("composited pixel outside the hole", pixelAt(frame.x - 40, cy));
        const showsThrough = inside.every((c, k) => Math.abs(c - SPIKE_BG[k]) <= COLOR_SLACK);
        expect(showsThrough).toBe(true);

        // (e) A native click inside the child's rect reaches the child.
        await app.nativeClick({ x: cx, y: cy });

        const reading = await app.spikeRun({ stallMs: STALL_MS, translatePx: TRANSLATE_PX });
        const { child, meter, burst, presentationAdvancedRatio } = reading;
        note("host display link over the stall", {
          periodMs: Number(meter.periodMs.toFixed(2)),
          ticks: meter.ticks,
          expectedTicks: meter.expectedTicks,
          missed: meter.missed,
          worstGapMs: Number(meter.worstGapMs.toFixed(1)),
        });
        note("(a) child rAF over the stall", {
          periodMs: Number(child.periodMs.toFixed(2)),
          ticks: child.ticks,
          expectedTicks: child.expectedTicks,
          worstGapMs: Number(child.worstGapMs.toFixed(1)),
          worstGapPeriods: Number((child.worstGapMs / child.periodMs).toFixed(2)),
        });
        note("(b) presentation advanced ratio", Number(presentationAdvancedRatio.toFixed(3)));
        note("(c) composited captures differing", `${burst.differing}/${burst.pairs}`);
        note("(e) child pointerdowns", child.pointerdowns);

        // (a) The child's frame production.
        expect(child.worstGapMs).toBeLessThanOrEqual(1.5 * child.periodMs);
        expect(child.ticks).toBeGreaterThanOrEqual(0.95 * child.expectedTicks);
        // (b) The render server's.
        expect(presentationAdvancedRatio).toBeGreaterThanOrEqual(0.95);
        // (c) The window's.
        expect(burst.pairs).toBeGreaterThan(0);
        expect(burst.differing / burst.pairs).toBeGreaterThanOrEqual(0.9);
        // (e) The click was the child's.
        expect(child.pointerdowns).toBe(1);

        await app.spikeDestroy();
      } finally {
        await app.close();
      }
    },
    120_000,
  );
});

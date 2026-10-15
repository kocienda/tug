/**
 * row-16-back-pane-cut.test.ts — a back card paints nothing inside a body
 * the host is carrying across it.
 *
 * The bar's sixteenth row. A pane behind a body is cut at the body's rect
 * (`chrome-under-bodies`), and when a settle carries the body on the host
 * the cut has to move with it: the placer gives each back pane the plan
 * touches a `clip-path` beat on the plan's own start, keyed to the samples
 * of the beat that moves the body, so the hole rides with the body as the
 * host moves it (`lib/body-placement.ts` `cutMoving`, `lib/body-beat-plan.ts`
 * `paneCutKeyframes`).
 *
 * A body card and a Text card stand in a three-up fit on a window too
 * narrow for the band, so their panes overlap; the Text card's file is lines
 * of block glyphs, so wherever its editor paints it paints ink. With the
 * body card in front, it is assigned to the empty third slot, which carries
 * its body across the Text card. On every composite frame judged in motion
 * the part of the body's content box the Text card's frame covers carries
 * no ink of the Text card. The shell's own gap rows over the motion are
 * noted, which is the cost the moving cut adds to the shell's frames. The
 * same slide is read twice: on the bare band, and with the Overview open in
 * a rail, whose document is the heaviest the shell's frames carry.
 *
 * @foreground
 * @covers tugdeck/src/lib/body-beat-plan.ts
 * @covers tugdeck/src/lib/body-placement.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "../_harness";
import type { CaptureBurstReading } from "../_harness/client";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { focusBody, pollFor, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { classifyFrame, describeFrames, framesDiffer, type FrameClasses } from "./_frames";
import {
  CORNER_INSET_PX,
  MOVED_PX,
  armSampler,
  edgeGap,
  expectAtRest,
  frameOf,
  intersect,
  planDiag,
  readSampler,
  readStanding,
  rectOf,
  sampleIndexAt,
  samplerState,
  type Rect,
} from "./_motion";

const TEST_NAME = "body-grounding-row-16-back-pane-cut";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const A = "r16-a";
const T = "r16-text";
const TEXT_EDITOR = `[data-card-id="${T}"] [data-slot="tug-text-card-editor"] .cm-content`;
const PANE_OF_T = `.tug-pane:has([data-card-id="${T}"])`;
const BURST_MS = 2_000;
const BURST_INTERVAL_MS = 16;
const SETTLE_MS = 6_000;
/** How much of the covered strip may read as ink: the body's own text, never the Text card's blocks. */
const INK_SHARE = 0.05;
/** A strip narrower than this, in px, is too thin to read past its inset corners. */
const MIN_STRIP_PX = 3 * CORNER_INSET_PX;

function deck(overview: boolean): Record<string, unknown> {
  const rail = {
    id: "r16-overview-pane",
    position: { x: 0, y: 0 },
    size: { width: 320, height: 900 },
    cardIds: ["r16-overview"],
    activeCardId: "r16-overview",
    title: "Overview",
    acceptsFamilies: [],
  };
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: T, componentId: "text", title: "Text", closable: true },
      ...(overview ? [{ id: "r16-overview", componentId: "overview", title: "Overview", closable: true }] : []),
    ],
    panes: [
      sessionPane(A, 0),
      {
        id: `${T}-pane`,
        position: { x: 40, y: 40 },
        size: { width: 640, height: 480 },
        cardIds: [T],
        activeCardId: T,
        title: "",
        acceptsFamilies: ["standard"],
        slot: 1,
      },
      ...(overview ? [rail] : []),
    ],
    activePaneId: `${A}-pane`,
    imposition: { kind: "three-up", layout: "fit", sidebars: overview ? { overview: { side: "left" } } : {} },
    hasFocus: true,
  };
}

/** The shell's gap rows recorded after `sinceSeq`. */
async function gapRowsSince(app: App, sinceSeq: number): Promise<{ class: string; gapMs: number; periodMs: number; startBeat: string; endBeat: string }[]> {
  return app.evalJS(
    `window.__deckTrace.dump().filter(function (e) { return e.kind === "settle-gap" && e.seq > ${sinceSeq}; })
      .map(function (e) { return { class: e.class, gapMs: e.gapMs, periodMs: e.periodMs, startBeat: e.startBeat, endBeat: e.endBeat }; })`,
  );
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 16: the back pane's cut moves with the carried body", () => {
  for (const overview of [false, true]) test(
    `a body carried across the Text card behind it shows no ink of the Text card on any frame in motion${overview ? ", with the Overview open" : ""}`,
    async () => {
      const leg = overview ? "with the Overview" : "bare band";
      const say = (text: string): void => note(`${leg}: ${text}`);
      const stubDir = stubDirectory();
      const textDir = mkdtempSync(join(tmpdir(), "tug-r16-text-"));
      const textFile = join(textDir, "blocks.txt");
      writeFileSync(textFile, Array.from({ length: 120 }, () => "█".repeat(110)).join("\n") + "\n");
      const app = await launchTugApp({
        testName: `${TEST_NAME}-${overview ? "overview" : "bare"}`,
        foreground: true,
        env: { TUG_BODY_VIEWS: "1", [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await app.seedDeckState({
          state: deck(overview),
          cardStates: { [T]: { content: { path: textFile, anchor: { line: 1, ch: 0 }, scrollTop: 0 } } },
          focusCardId: A,
        });
        await spawnStub(app, A, stubDir, 2);
        await waitForBody(app, A);
        await app.waitForCondition<boolean>(`document.querySelectorAll(${JSON.stringify(`${TEXT_EDITOR} .cm-line`)}).length > 5`, { timeoutMs: 30_000 });
        await focusBody(app, A, { composer: false });
        await Bun.sleep(600);

        const before = await expectAtRest(app, A, "before");
        const text = (await rectOf(app, frameOf(T)))!;
        expect(text.x < before.x + before.width, "T's frame overlaps A's content box").toBe(true);
        expect(await app.evalJS<boolean>(`(document.querySelector(${JSON.stringify(PANE_OF_T)})?.style.clipPath ?? "").indexOf("evenodd") >= 0`), "T's pane wears the cut at rest").toBe(true);
        const clear = { x: before.x, y: before.y, width: Math.max(40, text.x - before.x), height: before.height };
        const standing = await readStanding(app, A, clear);
        const crop = { x: 0, y: Math.floor(before.y), width: standing.contentWidth, height: Math.min(400, Math.ceil(before.height)) };
        const scale = standing.scale;

        const runsBefore = (await planDiag(app)).runs;
        const seq = await app.evalJS<number>(`(function () { var d = window.__deckTrace.dump(); return d.length === 0 ? 0 : d[d.length - 1].seq; })()`);
        await armSampler(app, A);
        await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop });
        const gestureWall = Date.now();
        await app.evalJS<null>(`(window.__tug.dispatchControlAction("assign-slot", { cardId: ${JSON.stringify(A)}, slot: 2 }), null)`);
        await pollFor(() => samplerState(app), (s) => s.saw && !s.now, SETTLE_MS);
        const plan = await pollFor(() => planDiag(app), (p) => p.runs > runsBefore && (p.last?.landed.some((l) => l.cardId === A) ?? false), 3_000);
        say(`last plan ${JSON.stringify(plan.last)}`);
        expect(plan.last?.planned.includes(A), "A's body is carried by the host").toBe(true);
        const cuts = await app.evalJS<{ lastCuts: Record<string, string>; cutsRunning: number }>(
          `(function () { var d = window.tugdeck.diag.getBodyPlacement(); return { lastCuts: d.lastCuts, cutsRunning: d.cutsRunning }; })()`,
        );
        say(`the plan's cuts ${JSON.stringify(cuts.lastCuts)}; ${cuts.cutsRunning} still running after the land`);
        expect(Object.values(cuts.lastCuts), "the plan cut the pane behind the body as it moved").not.toHaveLength(0);
        expect(cuts.cutsRunning, "no moving cut outlives the land").toBe(0);

        const samples = await readSampler(app);
        const reading = await pollFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000);
        expect(reading.done, "the burst finished").toBe(true);
        await focusBody(app, A, { composer: false });
        await Bun.sleep(300);
        const after = await expectAtRest(app, A, "after");
        const travelled = edgeGap(before, after);
        say(`A travelled ${travelled.toFixed(1)} px`);
        expect(travelled, "the slide moved the body").toBeGreaterThan(100);

        const moved = (k: number): boolean => {
          const p = k >= 0 ? samples[k].placeholder : null;
          return p !== null && edgeGap(p, before) > MOVED_PX && edgeGap(p, after) > MOVED_PX;
        };
        const standingFrame = reading.frames.filter((f) => f.wall < gestureWall).pop() ?? reading.frames[0];
        // Which side of the strip shows ink says whether the cut trails the body or leads it.
        const dir = Math.sign(after.x - before.x);
        const judged: { strip: FrameClasses; width: number; leading: number; trailing: number }[] = [];
        let motion = 0;
        for (const f of reading.frames) {
          if (f.wall < gestureWall) continue;
          const i = sampleIndexAt(samples, f.wall);
          if (i < 0 || samples[i].placeholder === null) continue;
          if (!(moved(i) && moved(i - 1) && framesDiffer(f, standingFrame))) continue;
          motion += 1;
          const box = intersect(intersect(samples[i].placeholder!, text), crop);
          if (box.width < MIN_STRIP_PX || box.height < MIN_STRIP_PX) continue;
          const strip = classifyFrame(f, standing.palette, 8, {
            x: (box.x - crop.x + CORNER_INSET_PX) * scale,
            y: (box.y - crop.y + CORNER_INSET_PX) * scale,
            width: (box.width - 2 * CORNER_INSET_PX) * scale,
            height: (box.height - 2 * CORNER_INSET_PX) * scale,
          });
          const quarter = (box.width - 2 * CORNER_INSET_PX) / 4;
          const side = (x: number): number =>
            classifyFrame(f, standing.palette, 8, {
              x: (x - crop.x) * scale,
              y: (box.y - crop.y + CORNER_INSET_PX) * scale,
              width: quarter * scale,
              height: (box.height - 2 * CORNER_INSET_PX) * scale,
            }).other;
          const left = side(box.x + CORNER_INSET_PX);
          const right = side(box.x + box.width - CORNER_INSET_PX - quarter);
          judged.push({ strip, width: box.width, leading: dir > 0 ? right : left, trailing: dir > 0 ? left : right });
        }
        const worst = judged.reduce<(typeof judged)[number] | null>((w, j) => (w === null || j.strip.other > w.strip.other ? j : w), null);
        say(
          `${reading.frames.length} frames, ${motion} judged in motion, ${judged.length} with the body over the Text card; ` +
            (worst === null
              ? "none read"
              : `the most ink in the covered strip ${(worst.strip.other * 100).toFixed(2)}% on a ${worst.width.toFixed(0)} px strip (${describeFrames([worst.strip])}), ` +
                `${(worst.leading * 100).toFixed(1)}% in its leading quarter and ${(worst.trailing * 100).toFixed(1)}% in its trailing one`),
        );
        const offenders = judged.filter((j) => j.strip.other > INK_SHARE);
        if (offenders.length > 0) say(`frames showing the Text card's ink inside the body\n${describeFrames(offenders.map((j) => j.strip))}`);
        expect(motion, "frames were captured while the body moved").toBeGreaterThan(3);
        expect(judged.length, "the body was read over the Text card while it moved").toBeGreaterThan(2);
        expect(offenders.length, "no frame in motion shows the Text card's ink inside the carried body").toBe(0);

        const gaps = await gapRowsSince(app, seq);
        const judder = gaps.filter((g) => g.class === "judder");
        const worstGap = judder.reduce<(typeof gaps)[number] | null>((w, g) => (w === null || g.gapMs > w.gapMs ? g : w), null);
        say(
          `the shell's gaps over the motion: ${judder.length} judder, ${gaps.length - judder.length} lead` +
            (worstGap === null ? "; no in-motion gap over a period" : `; worst in-motion ${worstGap.gapMs.toFixed(1)} ms (${(worstGap.gapMs / worstGap.periodMs).toFixed(2)} periods) ${worstGap.startBeat}→${worstGap.endBeat}`),
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

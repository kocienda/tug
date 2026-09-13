/**
 * AT0567: a quiet Session card's activity tape reads flat, not absent —
 * and reads that way with the canvas taken away.
 *
 * ## The report this reproduces
 *
 * A new Session card shows "No turns. Ready." and nothing at all where the
 * masthead's tape belongs — no line, no baseline, no box of ink. The design
 * says the opposite: a session that has done no work shows a FLATLINE, the
 * instrument reading zero rather than the instrument being absent, and
 * `session-identity-row.tsx` says so in a comment and mounts the tape
 * unconditionally.
 *
 * ## Why this is a pixel test, and what it names
 *
 * Every DOM fact about the vanished tape is correct: the container is
 * mounted, sized, and not hidden; the tape's own state says it painted. Only
 * the raster is wrong — and the raster is made in a render worker, off the
 * main thread, on a canvas whose control has been transferred away, so
 * `getImageData` cannot be reached from the page at all. The screenshot is
 * the only reading that sees what the user sees.
 *
 * The tape's box is read in three bands out of the snapshot, which is what
 * lets the test do more than fail:
 *
 *  - the BASELINE band, the bottom 3 CSS px where the geometry paints zero
 *    (`baselineY` is `height - 1 - 0.5`);
 *  - the FIELD above it, which at rest is blank by construction — the
 *    staircase is flat at zero and nothing rises off the baseline;
 *  - the SURROUND just outside the box, the masthead chrome the ink has to
 *    be told apart from.
 *
 * Ink is a pixel in a band deviating from the surround's median by more than
 * {@link INK_DELTA} on any channel. The three bands together, beside the
 * tape's recorded state and the track's transform and animation, name which
 * of the brief's three roads the card took rather than merely reporting that
 * it took one:
 *
 *  - no ink in EITHER band, tape state `flat-dormant` with points on it:
 *    the born-inert paint never reached the surface, or was drawn and
 *    dropped;
 *  - no ink in either band and a track transform far off zero: the parked
 *    scroll's transform disagrees with the painted origin, and the picture
 *    is somewhere outside the window (design decision D133's symptom);
 *  - no ink and a resolved `color` that matches the surround: colour was
 *    read before the masthead's chrome ink resolved, and the line is drawn
 *    in the background.
 *
 * All of it rides `note()` whichever way the assertion goes, because the
 * road is the finding this test was written to record.
 *
 * ## Two readings, because "at rest" is two states
 *
 * A card fresh off a bind is `live`: the bind itself is activity, and the
 * scroll is running. The reported card is the state AFTER that — the tape
 * transitions to `flat-dormant` once the last recognized change has scrolled
 * fully off ({@link DORMANT_AFTER_MS}, 19s), and from there it holds no
 * timers and no animation and will not repaint until an event arrives. So
 * the picture standing at the moment of that transition is the whole picture
 * the card shows for as long as the session is quiet, and it is the one the
 * report is about. Both readings are taken and both are asserted.
 *
 * ## Three readings, and why the third is the pin
 *
 * The first two readings would pass on the canvas's own zero stroke, which
 * is the line that has been lost four times before ([D133]). So the third
 * takes the canvas away — `visibility: hidden` on the `<canvas>`, which
 * leaves the container's `::before` untouched — and requires the baseline
 * band to carry ink anyway. That is the contract stated as a test: the
 * instrument survives anything the paint protocol can lose, because it is
 * not the paint protocol that draws it. Without the stylesheet's rest
 * baseline this reading is blank and this test is red, which is the only
 * reason it is worth keeping.
 *
 * ## What it asserts
 *
 * The baseline band carries ink — live, dormant, and with the canvas
 * hidden — and the field above it stays blank in all three, because a quiet
 * tape is one line and not a box.
 *
 * @covers tugdeck/src/components/tugways/tug-sparkline.tsx
 * @covers tugdeck/src/components/tugways/tug-sparkline.css
 * @covers tugdeck/src/lib/sparkline-tape.ts
 * @covers tugdeck/src/components/tugways/session-identity-row.tsx
 */

import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";

import { launchTugApp, note, type App } from "./_harness";
import { decodePngFile } from "./_harness/png";
import { DORMANT_AFTER_MS } from "../../tugdeck/src/lib/sparkline-tape";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0567-session";
const PANE_ID = "p1";
const PANE = `.tug-pane[data-pane-id="${PANE_ID}"]`;
/** The masthead's tape — the one a fresh card is reported to be missing. */
const SPARK = `${PANE} .session-masthead-row [data-slot="tug-sparkline"]`;
const TRACK = `${SPARK} .tug-sparkline-track`;

/**
 * How far a channel must sit off the surround's median to count as ink.
 *
 * The line is `currentColor` at `SPARKLINE_LINE_ALPHA` (0.85) over the muted
 * text token, which is far above this against the masthead's surface; a
 * blank box's own wash stays under it.
 */
const INK_DELTA = 12;

/** One Session card in one pane, wide enough that the tape is not squeezed. */
function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: PANE_ID,
        position: { x: 40, y: 40 },
        size: { width: 820, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: PANE_ID,
    hasFocus: true,
  };
}

/** Everything the page can say about the tape, read in one round trip. */
interface TapeReading {
  /** Viewport rect of the tape's box, CSS px. */
  left: number;
  top: number;
  width: number;
  height: number;
  innerWidth: number;
  /** The CSS-resolved ink the canvas colour is read from. */
  color: string;
  opacity: string;
  visibility: string;
  /** `SparklineTapeDebugState`, or null when no tape is registered. */
  tape: { state: string; t0: number; points: number; lastV: number } | null;
  /** The scrolling layer's committed transform, as a matrix string. */
  trackTransform: string;
  /** The WAAPI scroll, if one is registered on the track. */
  anim: { playState: string; startTime: number | null; currentTime: number | null } | null;
  /** The canvas's backing store, to tell a sized surface from an unsized one. */
  canvasW: number;
  canvasH: number;
  /**
   * The rest baseline's own resolved box and ink — the stylesheet fact the
   * canvas cannot lose. Read off `::before` so a rule that never reached the
   * element is a null here rather than ink the canvas happens to supply.
   */
  rest: { bottom: string; height: string; background: string; opacity: string } | null;
}

async function readTape(app: App): Promise<TapeReading> {
  return app.evalJS<TapeReading>(
    `(function () {
      var box = document.querySelector(${JSON.stringify(SPARK)});
      var track = document.querySelector(${JSON.stringify(TRACK)});
      var canvas = box === null ? null : box.querySelector("canvas");
      var r = box === null
        ? { left: -1, top: -1, width: -1, height: -1 }
        : box.getBoundingClientRect();
      var cs = box === null ? null : getComputedStyle(box);
      var anims = track === null ? [] : track.getAnimations();
      var a = anims.length > 0 ? anims[0] : null;
      var rest = null;
      if (box !== null) {
        var bs = getComputedStyle(box, "::before");
        if (bs.content !== "none") {
          rest = {
            bottom: bs.bottom,
            height: bs.height,
            background: bs.backgroundColor,
            opacity: bs.opacity,
          };
        }
      }
      return {
        left: r.left, top: r.top, width: r.width, height: r.height,
        innerWidth: window.innerWidth,
        color: cs === null ? "" : cs.color,
        opacity: cs === null ? "" : cs.opacity,
        visibility: cs === null ? "" : cs.visibility,
        tape: box === null ? null : window.__tug.sparklineTapeState(${JSON.stringify(SPARK)}),
        trackTransform: track === null ? "" : getComputedStyle(track).transform,
        anim: a === null ? null : {
          playState: a.playState,
          startTime: a.startTime === null ? null : Number(a.startTime),
          currentTime: a.currentTime === null ? null : Number(a.currentTime),
        },
        canvasW: canvas === null ? -1 : canvas.width,
        canvasH: canvas === null ? -1 : canvas.height,
        rest: rest,
      };
    })()`,
  );
}

/** How much ink a band of the snapshot carries, against the surround. */
interface BandInk {
  /** Pixels in the band deviating from the surround's median. */
  inkPixels: number;
  /** Total pixels examined, so the count reads as a fraction. */
  totalPixels: number;
  /** The largest deviation seen, which is what a near-miss is legible as. */
  maxDelta: number;
}

/** The three bands of one snapshot, plus the surround they are judged against. */
interface TapeInk {
  baseline: BandInk;
  field: BandInk;
  /** The surround's median RGB — the background ink is told apart from. */
  surroundRgb: [number, number, number];
}

/**
 * Read the tape's box out of a snapshot in bands.
 *
 * The surround is the 6 CSS px strip immediately LEFT of the box, which is
 * masthead chrome in every form the card takes, so the median there is the
 * background the line has to be visible against. Judging the bands against
 * their own median instead — the shape at0205 uses for a chip label — cannot
 * work here: at rest the flatline may be the only ink in the box, so the
 * box's own median IS the background in the healthy case and is the whole
 * box in the vanished one, and the two would read alike.
 */
function readInk(pngPath: string, box: TapeReading): TapeInk {
  const png = decodePngFile(pngPath);
  const scale = png.width / box.innerWidth;
  const px = (v: number): number => Math.round(v * scale);

  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * png.width + x) * 4;
    return [png.rgba[i]!, png.rgba[i + 1]!, png.rgba[i + 2]!];
  };

  const x0 = px(box.left);
  const x1 = px(box.left + box.width);
  const yTop = px(box.top);
  const yBot = px(box.top + box.height);
  // The baseline row is 1 CSS px up from the bottom edge; take the bottom 3
  // so a device-pixel rounding either way still lands inside the band.
  const yBaseline = px(box.top + box.height - 3);

  // Surround: the strip just left of the box, same rows.
  const sx0 = Math.max(0, px(box.left - 6));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = yTop; y < yBot; y++) {
    for (let x = sx0; x < x0; x++) {
      const [r, g, b] = at(x, y);
      rs.push(r);
      gs.push(g);
      bs.push(b);
    }
  }
  const median = (v: number[]): number => {
    if (v.length === 0) return 0;
    const s = [...v].sort((a, b) => a - b);
    return s[s.length >> 1]!;
  };
  const surround: [number, number, number] = [median(rs), median(gs), median(bs)];

  const band = (ya: number, yb: number): BandInk => {
    let inkPixels = 0;
    let totalPixels = 0;
    let maxDelta = 0;
    for (let y = ya; y < yb; y++) {
      for (let x = x0; x < x1; x++) {
        const [r, g, b] = at(x, y);
        const d = Math.max(
          Math.abs(r - surround[0]),
          Math.abs(g - surround[1]),
          Math.abs(b - surround[2]),
        );
        if (d > maxDelta) maxDelta = d;
        if (d > INK_DELTA) inkPixels += 1;
        totalPixels += 1;
      }
    }
    return { inkPixels, totalPixels, maxDelta };
  };

  return {
    baseline: band(yBaseline, yBot),
    field: band(yTop, yBaseline),
    surroundRgb: surround,
  };
}

/**
 * Hide or restore the tape's `<canvas>`, leaving the container's `::before`
 * alone. `visibility` rather than `display`: the element keeps its box, so
 * nothing about the tape's layout — and nothing the tape's own protocol
 * watches — moves under the reading.
 */
async function setCanvasHidden(app: App, hidden: boolean): Promise<void> {
  await app.evalJS<null>(
    `(function () {
       var c = document.querySelector(${JSON.stringify(SPARK)} + " canvas");
       if (c !== null) c.style.visibility = ${hidden ? '"hidden"' : '""'};
       return null;
     })()`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "AT0567: a quiet session's tape reads flat, not absent",
  () => {
    test(
      "a fresh Session card, before any turn, has ink at its tape's baseline",
      async () => {
        const app = await launchTugApp({
          testName: "at0567-sparkline-rest-baseline",
        });
        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { tugSessionId: SID });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SPARK)}) !== null`,
            { timeoutMs: 20_000 },
          );

          // The tape is born inert and paints exactly ONCE — it holds no
          // timers and no animation while quiet, so there is nothing to
          // settle against and nothing that would repair a lost first paint
          // later. A beat for the claim, the worker transfer and the
          // compositor commit is all this can wait for, and waiting longer
          // would only hide a paint that arrived late.
          await new Promise<void>((r) => setTimeout(r, 2_000));

          const box = await readTape(app);
          note("at0567 tape box", JSON.stringify(box));

          expect(box.width, "the tape is mounted and sized").toBeGreaterThan(8);
          expect(box.height, "the tape is mounted and sized").toBeGreaterThan(4);

          // The rest baseline is a stylesheet fact, so it is readable before
          // any pixel is: a rule that never reached the element reads null
          // here, and the ink assertions below would then be the canvas's
          // alone without anything saying so.
          expect(box.rest, "the rest baseline rule reaches the tape").not.toBeNull();
          expect(box.rest!.height, "one stroke thick").toBe("1px");
          expect(box.rest!.bottom, "on the geometry's zero row").toBe("1px");

          const shot = await app.screenshot();
          let ink: TapeInk;
          try {
            ink = readInk(shot.path, box);
          } finally {
            if (process.env.AT0567_KEEP_SHOTS !== "1") {
              try {
                unlinkSync(shot.path);
              } catch {
                /* the harness reclaims what is left */
              }
            }
          }
          note("at0567 ink, baseline band", JSON.stringify(ink.baseline));
          note("at0567 ink, field above", JSON.stringify(ink.field));
          note("at0567 surround median rgb", JSON.stringify(ink.surroundRgb));

          // The contract: the instrument is visible at rest. A flat line
          // across the box is a run of ink the width of the tape, so a
          // handful of pixels is a rounding artifact rather than a line —
          // require a quarter of the box's width.
          expect(
            ink.baseline.inkPixels,
            "the quiet tape's baseline carries ink",
          ).toBeGreaterThan(box.width * 0.25);

          // ── Reading 2: the reported state ────────────────────────────
          // The tape retires its scroll DORMANT_AFTER_MS after the last
          // recognized change, and from there repaints never. Wait for the
          // transition itself rather than for a duration, so the reading is
          // of the dormant tape and not of a live one that was about to be.
          await app.waitForCondition<boolean>(
            `(function () {
               var s = window.__tug.sparklineTapeState(${JSON.stringify(SPARK)});
               return s !== null && s.state === "flat-dormant";
             })()`,
            { timeoutMs: DORMANT_AFTER_MS + 15_000 },
          );
          // A beat for the parked transform and the retiring paint to commit.
          await new Promise<void>((r) => setTimeout(r, 500));

          const restBox = await readTape(app);
          note("at0567 tape box, dormant", JSON.stringify(restBox));

          const restShot = await app.screenshot();
          let restInk: TapeInk;
          try {
            restInk = readInk(restShot.path, restBox);
          } finally {
            if (process.env.AT0567_KEEP_SHOTS !== "1") {
              try {
                unlinkSync(restShot.path);
              } catch {
                /* the harness reclaims what is left */
              }
            }
          }
          note("at0567 ink at rest, baseline band", JSON.stringify(restInk.baseline));
          note("at0567 ink at rest, field above", JSON.stringify(restInk.field));

          expect(
            restInk.baseline.inkPixels,
            "the dormant tape's baseline carries ink",
          ).toBeGreaterThan(restBox.width * 0.25);

          // ── Reading 3: the pin ───────────────────────────────────────
          // Take the canvas away. What is left at the baseline is the
          // stylesheet's alone, and it is what the report asked for: the
          // instrument reading zero, out of reach of the paint protocol.
          await setCanvasHidden(app, true);
          await new Promise<void>((r) => setTimeout(r, 300));

          const bareShot = await app.screenshot();
          let bareInk: TapeInk;
          try {
            bareInk = readInk(bareShot.path, restBox);
          } finally {
            await setCanvasHidden(app, false);
            if (process.env.AT0567_KEEP_SHOTS !== "1") {
              try {
                unlinkSync(bareShot.path);
              } catch {
                /* the harness reclaims what is left */
              }
            }
          }
          note("at0567 ink without the canvas, baseline band", JSON.stringify(bareInk.baseline));
          note("at0567 ink without the canvas, field above", JSON.stringify(bareInk.field));

          expect(
            bareInk.baseline.inkPixels,
            "the baseline survives the canvas being taken away",
          ).toBeGreaterThan(restBox.width * 0.25);

          // And it is a LINE, not a wash: nothing above the baseline row.
          expect(ink.field.inkPixels, "the live tape's field is blank").toBe(0);
          expect(restInk.field.inkPixels, "the dormant tape's field is blank").toBe(0);
          expect(bareInk.field.inkPixels, "the bare baseline's field is blank").toBe(0);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0567] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

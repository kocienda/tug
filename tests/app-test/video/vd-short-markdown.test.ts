/**
 * vd-short-markdown.test.ts — the first YouTube Short: the prompt entry's
 * light markdown styling, one construct per line, typed a character at a time
 * so each style is seen to arrive as its closing marker lands — a heading,
 * the three weights of emphasis, code, strikethrough, a nested list with a
 * struck item, a quote and a fenced block.
 * Nothing is sent: the Short ends on the finished prompt, every marker still
 * on screen.
 *
 * A video tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that frames were written. It lives beside the other
 * video drivers and shares the site clips' helpers and gate: run by path with
 * `TUG_SITE_CLIPS_OUT` and `TUG_SITE_CLIPS_MODE` set; with either unset it
 * skips. The `vids` repo's `tools/shot.py short-markdown` is the usual
 * caller, and its `tools/short.py` composes the portrait frame.
 *
 * The frame is portrait, 1080 × 1920, and a Session card has a 675 px floor,
 * so the whole card cannot be both in frame and legible on a phone. The card
 * is therefore recorded large — View › Zoom at 1.5, so a CSS pixel is three
 * captured pixels — and the composer's camera does the rest: it opens on the
 * whole card, then pushes in on the entry's left 360 px at one captured pixel
 * to one frame pixel. Every line of the prompt is kept under 38 characters
 * so it reads inside that view, and the driver's part is only to record the
 * card and say where it stood (`shot.json`).
 *
 * The times are seconds of the narration, `incoming/short-markdown.wav` in the
 * `vids` repo (`LINES`, `SEAM`, `END`), taken from its word timestamps
 * (`build/transcribe` there); each entry names the words it lands on. The burst cap
 * is 30 s, so the scene is two bursts meeting at `SEAM`, between two lines,
 * where nothing on screen moves.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { App } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import { stubDirectory } from "../streaming-stub-fixture";
import { bashTurnTranscript } from "../site-clips/_components";
import { MODE, RUNS, type Scene, contentSize, expectRecorded, launchForMode, outDirFor, scene, standIns } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 300_000;
const SHOT = "short-markdown";
const CARD = "vd-short-md";
const PROJECT_NAME = "tug";

/** View › Zoom: with the 2× backing store, one CSS pixel is three captured pixels. */
const PAGE_ZOOM = 1.5;
/** The card in CSS pixels: the Session card's width floor, and a height that holds the eleven lines: the entry, toolbar included, scrolls past half the card. */
const CARD_CSS = { width: 675, height: 810 };
/** The deck's margin around a one-up card, in CSS pixels. */
const MARGIN_CSS = 10;
const CONTENT_SIZE = {
  width: Math.ceil((CARD_CSS.width + 2 * MARGIN_CSS) * PAGE_ZOOM),
  height: Math.ceil((CARD_CSS.height + 2 * MARGIN_CSS) * PAGE_ZOOM),
};

const ENTRY = '[data-slot="tug-prompt-entry"]';
const FIELD = `${ENTRY} [data-slot="tug-text-editor"] .cm-content`;

/** A character every this long: quick, and slow enough that a style is seen to arrive. */
const CHAR_MS = 50;
/** A line's Return lands this long before its first character. */
const RETURN_LEAD_MS = 150;

/**
 * The prompt, a line per construct, each with the second of narration its first character lands on. An entry
 * marked `true` carries on the line before it instead of starting one, so a line can be typed in phrases.
 */
const LINES: ReadonlyArray<readonly [number, string, boolean?]> = [
  // "Hash marks make headers,"
  [6.84, "# Fix the restore bug"],
  // "one asterisk for emphasis," / "two for strong emphasis," / "and three for both."
  [8.6, "Do it *now*,"],
  [10.4, " **well**,", true],
  [11.4, " ***for good***.", true],
  // "Backticks make a code span,"
  [12.85, "Look at `restore()` first."],
  // "tildes strike out a second thought" / "or a completed item."
  [14.7, "~~Rewrite it~~ Keep the change small."],
  [17.1, "- ~~reproduce it~~"],
  // "Hyphens make a list with indents."
  [19.1, "- fix it"],
  // Four spaces, not two: the indent Gruber's syntax page gives for what belongs to a list item, and a nested list in CommonMark too.
  [20.1, "    - with a test"],
  // "An angle bracket makes a blockquote."
  [21.9, "> It logged me out again!"],
  // "A fenced block gets real syntax highlighting for the language."
  [24.1, "```ts"],
  [24.9, "await session.restore();"],
  [26.9, "```"],
];
/** Where the two bursts meet (the pause before "Hyphens"), and where the narration ends. */
const SEAM = 18.5;
const END = 38.9;

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: CARD, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${CARD}-pane`,
        position: { x: MARGIN_CSS, y: MARGIN_CSS },
        size: CARD_CSS,
        cardIds: [CARD],
        activeCardId: CARD,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${CARD}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** Schedule the lines whose start falls in `[from, to)` on `s`, whose zero is `from` seconds of narration. */
function typeLines(s: Scene, app: App, from: number, to: number): void {
  // A line's Return must come after the line before it has finished: the acts are sent as they fall due, and one
  // scheduled inside another line's typing lands inside that line.
  LINES.forEach(([at, text], index) => {
    const next = LINES[index + 1];
    const done = at + (text.length * CHAR_MS) / 1000;
    if (next !== undefined && done + 0.3 > next[0] - RETURN_LEAD_MS / 1000) throw new Error(`video: "${text}" is still being typed at ${done.toFixed(2)} s, too close to the next entry at ${next[0]} s`);
  });
  LINES.forEach(([at, text, continues], index) => {
    if (at < from || at >= to) return;
    const t0 = Math.round((at - from) * 1000);
    if (index > 0 && !continues) s.at(t0 - RETURN_LEAD_MS, () => app.nativeKey("Return"));
    // Return carries an indented line's indent onto the next; a line that does not want it deletes back to the margin.
    // The line before is read from its first entry: a phrase carrying a line on may open with a space of its own.
    let before = index - 1;
    while (before > 0 && LINES[before]![2]) before--;
    const carried = index > 0 && !continues && LINES[before]![1].startsWith(" ");
    if (carried && !text.startsWith(" ")) s.at(t0 - RETURN_LEAD_MS / 2, () => app.nativeKey("Backspace", ["cmd"]));
    [...text].forEach((ch, i) => s.at(t0 + i * CHAR_MS, () => app.nativeType(ch)));
  });
}

describe.skipIf(!RUNS)("video shot: the markdown-styling Short", () => {
  test(
    "records a prompt typed a construct per line, each styling itself as it lands",
    async () => {
      const stubDir = stubDirectory();
      const tugSessionId = randomUUID();
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "vd-short-md-")));
      onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
      const projectDir = join(scratch, PROJECT_NAME);
      mkdirSync(projectDir);
      // The card is bound to a stub it never prompts: the entry is the whole scene.
      writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(bashTurnTranscript()));

      const app = await launchForMode("vd-short-markdown", deck(), stubDir, { contentSize: CONTENT_SIZE });
      try {
        await app.setPageZoom(PAGE_ZOOM);
        await app.spawnSessionNew(CARD, { tugSessionId, projectDir });
        await pollFor(
          () =>
            app
              .body(CARD)
              .evalJS<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`)
              .catch(() => false),
          (bound) => bound,
          30_000,
        );
        const body = app.body(CARD);
        await body.nativeClickAtElement(FIELD);
        // The zoom's badge fades on its own; nothing is recorded until it has.
        await Bun.sleep(3_500);

        const card = (await standIns(app))[CARD];
        expect(card, "the card has a stand-in").toBeDefined();
        const window = await contentSize(app);

        const a = scene().mark("loop-start", 0);
        typeLines(a, app, 0, SEAM);
        a.mark("loop-end", Math.round(SEAM * 1000));
        const readingA = await a.record(app, { outDir: outDirFor(`${SHOT}-a`), settleMs: 300 });
        expectRecorded(readingA);

        const b = scene().mark("loop-start", 0);
        typeLines(b, app, SEAM, END);
        b.mark("loop-end", Math.round((END - SEAM) * 1000));
        const readingB = await b.record(app, { outDir: outDirFor(`${SHOT}-b`), settleMs: 300 });

        const typed = await body.evalJS<string>(`document.querySelector(${JSON.stringify(FIELD)}).innerText`);
        const notes = {
          typed,
          entry: await app.elementRect(CARD, ENTRY),
          field: await app.elementRect(CARD, FIELD),
          lines: LINES.map(([at, text, continues]) => ({ at, text, continues: continues === true })),
        };
        for (const [name, reading, offset] of [[`${SHOT}-a`, readingA, 0], [`${SHOT}-b`, readingB, SEAM]] as const) {
          writeFileSync(
            join(outDirFor(name), "shot.json"),
            JSON.stringify({ shot: name, mode: MODE, audioOffsetSecs: offset, pageZoom: PAGE_ZOOM, contentSize: window, card, crop: reading.crop, marks: reading.marks, frames: reading.frames, scale: reading.scale, notes }, null, 2),
          );
        }
        expectRecorded(readingB);
        expect(typed.trimEnd(), "every line landed as written").toBe(LINES.map(([, text, continues], i) => (i === 0 || continues ? "" : "\n") + text).join(""));
        const scrolled = await body.evalJS<number>(`document.querySelector(${JSON.stringify(ENTRY)} + ' .cm-scroller').scrollTop`);
        expect(scrolled, "the entry held every line without scrolling").toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

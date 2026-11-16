/**
 * sc-chart-story.test.ts — the site's chart-story stills: turns of a real
 * session, each rendered to an image by Share Turns.
 *
 * A site tool, not a test of the app: it resumes a recorded session, drives
 * the Share Turns shade over it, and its one assertion is that the images
 * were written. Run by path in one mode (`_site-clips.ts` has the
 * invocation); skips unless the runner and both site variables are set.
 *
 * The scene: one Session card resumed onto the session named by
 * `TUG_SITE_STORY_SESSION` (a uuid recorded in this checkout), replayed from
 * its transcript on disk by a real `spawn_session(mode=resume)`. No prompt is
 * sent, so the session is read and never continued. For each figure the
 * driver marks one turn's prompt and its answer in the shade, chooses Image,
 * presses Preview… and copies the artifact the host rendered to
 * `$TUG_SITE_CLIPS_OUT/chart-story/<mode>/<name>.png`. Tool calls render as
 * summaries, the shade's default, so a recipe's chart rides its Bash block.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { waitForBodyReady } from "../_harness/card-reach";
import { pollFor } from "../body-grounding/_frames";
import { CLEAR, COUNT, MARK_ALL, SHADE, USER_ROWS, chooseFormat, previewAndDismiss } from "../share-probes";
import { sessionDeck } from "./_components";
import { RUNS, launchForMode, outDirFor } from "./_site-clips";

const TEST_TIMEOUT_MS = 420_000;
/** `share-probes.ts` addresses card A. */
const CARD = "A";
const REPO = resolve(import.meta.dir, "../../..");
const SESSION = process.env.TUG_SITE_STORY_SESSION;
const CONTENT_SIZE = { width: 1120, height: 1420 };

/** The figures, each one conversation turn (1-based) of the session: its prompt and its answer. */
const FIGURES: readonly { name: string; turn: number }[] = [
  { name: "commits", turn: 1 },
  { name: "recipe-list", turn: 2 },
  { name: "commit-kinds", turn: 3 },
  { name: "arcs", turn: 4 },
  { name: "arc-timeline", turn: 5 },
  { name: "test-history", turn: 6 },
  { name: "commit-hours", turn: 7 },
];
const TURNS = Math.max(...FIGURES.map((f) => f.turn));

const countJs = `(function(){ var el = document.querySelector(${JSON.stringify(COUNT)}); var m = el === null ? null : /\\d+/.exec(el.textContent || ""); return m === null ? -1 : Number(m[0]); })()`;

describe.skipIf(!RUNS || SESSION === undefined)("site still: the chart story", () => {
  test(
    "renders each turn of the story through Share Turns",
    async () => {
      const app = await launchForMode("sc-chart-story", sessionDeck(CARD, { width: 760, height: 1360 }), undefined, { contentSize: CONTENT_SIZE });
      try {
        await app.spawnSessionResume(CARD, { tugSessionId: SESSION!, projectDir: REPO });
        const body = await waitForBodyReady(app, CARD);
        await pollFor(
          () => body.evalJS<number>(`document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length`).catch(() => 0),
          (rows) => rows > 0,
          60_000,
        );

        await app.performMenuItem("file.shareTurns");
        await body.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(SHADE)})`, { timeoutMs: 10_000 });

        // The replay is whole when Select All counts every prompt and answer.
        const entries = await pollFor(
          async () => {
            await body.nativeClickAtElement(MARK_ALL);
            await Bun.sleep(500);
            return body.evalJS<number>(countJs);
          },
          (count) => count >= TURNS * 2,
          90_000,
        );
        expect(entries, "the session's turns are a prompt and an answer each").toBe(TURNS * 2);
        await Bun.sleep(3_000);
        await chooseFormat(app, "png");

        const outDir = outDirFor("chart-story");
        for (const figure of FIGURES) {
          await body.nativeClickAtElement(CLEAR);
          // A cleared shade's count carries no number.
          await body.waitForCondition<boolean>(`${countJs} <= 0`, { timeoutMs: 5_000 });
          const prompt = (figure.turn - 1) * 2;
          expect(await body.evalJS<number>(`window.__tug.shareMark(${JSON.stringify(CARD)}, [${prompt}, ${prompt + 1}])`), `${figure.name}: two entries marked`).toBe(2);
          await previewAndDismiss(app, 45_000);
          await body.waitForCondition<boolean>(
            `(function(){ var s = window.__tug.shareState(${JSON.stringify(CARD)}); return s !== null && s.held && s.lastArtifact !== null && s.lastArtifact.format === "png"; })()`,
            { timeoutMs: 10_000 },
          );
          const path = await body.evalJS<string>(`window.__tug.shareState(${JSON.stringify(CARD)}).lastArtifact.path`);
          expect(existsSync(path), `${figure.name}: the image is on disk`).toBe(true);
          copyFileSync(path, join(outDir, `${figure.name}.png`));
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

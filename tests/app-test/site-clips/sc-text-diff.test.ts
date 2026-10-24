/**
 * sc-text-diff.test.ts — the site's Text-and-Diff still: a Text card with
 * its find bar open beside a Diff card, one window capture per mode.
 *
 * A site tool, not a test of the app: it stages a scene and records it, and
 * its one assertion is that the still was written. Run by path, once per
 * mode (`_site-clips.ts` has the invocation); skips unless the runner and
 * both site variables are set.
 *
 * The scene: a Text card over a scratch TypeScript file, seeded the way
 * `at0210-text-card-options.test.ts` seeds its card, with ⌘F's bottom find
 * bar open on a query that has several hits (`at0223-text-card-find-bar`'s
 * gesture); and a Diff card over one pinned commit of this checkout, seeded
 * the way `body-grounding/kind-documents.test.ts` seeds its Diff card — a
 * commit rather than a scratch repository's working tree, because a diff
 * fetch resolves its root against the registered workspaces and a scratch
 * repository is never one. The two stand side by side in a two-up under Fit,
 * and the whole content area is captured; the site's `tools/crop-excerpts.mjs`
 * cuts each card out of the still.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { App, BodyApp } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { standUpKind } from "../body-grounding/_kind-bodies";
import { cardKind, kindPane } from "../body-grounding/_kinds";
import { MODE, RUNS, THEME_FOR_MODE, contentSize, launchForMode, outDirFor, standIns, stillTo } from "./_site-clips";

const TEST_TIMEOUT_MS = 110_000;
const TEXT = "sc-text";
const DIFF = "sc-diff";

/** A commit of this checkout with one readable TypeScript hunk: the completion popup's scroll fix. */
const PINNED_COMMIT = "978c0528c";
/** The find bar's query — a word the file carries several times. */
const QUERY = "frame";

const EDITOR_CONTENT = '[data-slot="tug-text-card-editor"] .cm-content';
const FIND_BAR = '[data-slot="text-card-find-bar"]';
const FIND_INPUT = `${FIND_BAR} [data-testid="text-card-find-input"] .cm-content`;

/**
 * The file the Text card shows: a small module that reads naturally at the
 * card's width, under a plain path, since the masthead prints the directory.
 */
const PROJECT_DIR = "/tmp/tug-site";
const FILE_PATH = join(PROJECT_DIR, "src/lib/frame-clock.ts");
const FILE_BODY = `/**
 * frame-clock.ts — one clock for every animation on the deck.
 *
 * Every animator asks this clock for the frame it is on rather than
 * reading the wall clock itself, so a paused deck pauses every motion
 * at once and a test can step the frame by hand.
 */

export interface FrameClock {
  /** The frame the deck is painting now. */
  readonly frame: number;
  /** Milliseconds since the clock started, at the last frame. */
  readonly elapsedMs: number;
  /** Advance to the next frame; returns the frame reached. */
  tick(nowMs: number): number;
  /** Hold the frame where it is until \`resume\`. */
  pause(): void;
  resume(): void;
}

export function createFrameClock(startMs: number): FrameClock {
  let frame = 0;
  let elapsedMs = 0;
  let paused = false;
  let lastMs = startMs;

  return {
    get frame() {
      return frame;
    },
    get elapsedMs() {
      return elapsedMs;
    },
    tick(nowMs) {
      if (paused) return frame;
      elapsedMs += nowMs - lastMs;
      lastMs = nowMs;
      frame += 1;
      return frame;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
  };
}
`;

function deck(): Record<string, unknown> {
  return {
    cards: [
      { id: TEXT, componentId: "text", title: "Text", closable: true },
      { id: DIFF, componentId: "diff", title: "Diff", closable: true },
    ],
    panes: [kindPane("text", TEXT, 0), kindPane("diff", DIFF, 1)],
    activePaneId: `${TEXT}-pane`,
    imposition: { kind: "two-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** ⌘F on the editor, the way at0223 sends it, then wait for the bar's field to hold the caret. */
async function openFindBar(body: BodyApp): Promise<void> {
  await body.nativeClickAtElement(EDITOR_CONTENT);
  await body.evalJS<boolean>(
    `(function(){
      var target = document.activeElement || document;
      return target.dispatchEvent(new KeyboardEvent("keydown", {
        code: "KeyF", key: "f", metaKey: true,
        bubbles: true, cancelable: true, composed: true,
      }));
    })()`,
  );
  await body.waitForCondition<boolean>(`document.querySelector(${JSON.stringify(FIND_BAR)}) !== null`, { timeoutMs: 4_000 });
  await body.waitForCondition<boolean>(
    `(() => {
      const input = document.querySelector(${JSON.stringify(FIND_INPUT)});
      return input !== null && document.activeElement !== null &&
        (input.contains(document.activeElement) || input === document.activeElement);
    })()`,
    { timeoutMs: 4_000 },
  );
}

describe.skipIf(!RUNS)("site still: Text and Diff", () => {
  test(
    "captures a Text card with its find bar open beside a Diff card",
    async () => {
      const repo = git(import.meta.dir, ["rev-parse", "--show-toplevel"]);
      const sha = git(repo, ["rev-parse", PINNED_COMMIT]);
      mkdirSync(join(PROJECT_DIR, "src/lib"), { recursive: true });
      onTestRunEnd(() => rmSync(PROJECT_DIR, { recursive: true, force: true }));
      writeFileSync(FILE_PATH, FILE_BODY, "utf8");

      // An empty launch deck: the cards mount from the seed below, with their
      // states, rather than from the restore (see `launchForMode`).
      const app = await launchForMode("sc-text-diff", { cards: [], panes: [], imposition: { sidebars: {} } });
      try {
        await app.seedDeckState({
          state: deck(),
          cardStates: {
            [TEXT]: { content: { path: FILE_PATH, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
            [DIFF]: { content: { descriptor: { kind: "commit", root: repo, sha } } },
          },
          focusCardId: TEXT,
        });
        const text = await standUpKind(app, cardKind("text"), TEXT);
        await standUpKind(app, cardKind("diff"), DIFF);
        await text.waitForCondition<boolean>(
          `(function(){ var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT)}); return el !== null && el.innerText.indexOf("FrameClock") !== -1; })()`,
          { timeoutMs: 15_000 },
        );
        await openFindBar(text);
        await app.nativeType(QUERY);
        await Bun.sleep(1_200);
        expect(
          await app.evalJS<string>(`document.documentElement.dataset.themeMode || ""`),
          "the window is still in the mode being recorded",
        ).toBe(MODE ?? "");

        const outDir = outDirFor("text-diff");
        const { scale } = await stillTo(app, undefined, join(outDir, "still.png"));
        const content = await contentSize(app);
        // Where each card stands, in content points, for the site's crop table.
        const cards = await standIns(app);
        writeFileSync(
          join(outDir, "reading.json"),
          JSON.stringify({ clip: "text-diff", mode: MODE, theme: THEME_FOR_MODE[MODE!], scale, crop: null, contentWidth: content.width, contentHeight: content.height, cards, commit: sha, file: FILE_PATH, query: QUERY }, null, 2),
        );
        expect(scale, "the still was taken").toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

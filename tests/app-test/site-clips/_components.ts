/**
 * _components.ts — what the site's component clips share.
 *
 * The Tug site's "Component system" row shows six of the app's components in
 * motion, and most of them are recorded off the Component Gallery: one
 * gallery card in a one-up, cropped to the sections the clip is about, with
 * the driver pressing the card's own controls natively. Two scenes are
 * recorded off a Session card instead — the tool blocks and the theme sweep
 * want a real transcript behind them — and they share the one stub turn
 * here: a build, a diff and a type check, each a Bash block.
 *
 * Every driver stamps the element it is about to press with `data-sc-target`
 * and presses that, because the harness clicks a selector and most of what
 * a gallery card offers is addressed by its label text.
 */

import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type App, type BodyApp } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { pollFor } from "../body-grounding/_frames";
import type { Rect } from "../one-view-fixture";

/** The attribute a driver stamps on the element it is about to press. */
export const TARGET = "data-sc-target";
/** The selector the stamped element answers to. */
export const TARGET_SEL = `[${TARGET}]`;

/** A one-up deck holding one gallery card, sized for the sections a clip crops to. */
export function galleryDeck(cardId: string, componentId: string, title: string, size: { width: number; height: number } = { width: 760, height: 960 }): Record<string, unknown> {
  return {
    cards: [{ id: cardId, componentId, title, closable: true }],
    panes: [
      {
        id: `${cardId}-pane`,
        position: { x: 40, y: 40 },
        size,
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${cardId}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** Wait until the gallery card's root (`data-testid`) is in the body. */
export async function waitForGallery(body: BodyApp, testId: string, timeoutMs = 30_000): Promise<void> {
  await pollFor(
    () => body.evalJS<boolean>(`document.querySelector('[data-testid=${JSON.stringify(testId)}]') !== null`).catch(() => false),
    (ok) => ok,
    timeoutMs,
  );
}

/**
 * Stamp {@link TARGET} on the `index`th element `selector` matches, or on the
 * one whose trimmed text is `text`, clearing any earlier stamp first.
 */
export async function aim(body: BodyApp, selector: string, pick: { index: number } | { text: string }): Promise<void> {
  const found = await body.evalJS<boolean>(
    `(function(){
       document.querySelectorAll(${JSON.stringify(TARGET_SEL)}).forEach(function (el) { el.removeAttribute(${JSON.stringify(TARGET)}); });
       var all = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(selector)}));
       var el = ${"index" in pick ? `all[${pick.index}]` : `all.find(function (e) { return (e.textContent || "").trim() === ${JSON.stringify(pick.text)}; })`};
       if (!el) return false;
       el.setAttribute(${JSON.stringify(TARGET)}, "");
       return true;
     })()`,
  );
  expect(found, `an element to press: ${selector} ${JSON.stringify(pick)}`).toBe(true);
}

/** Aim at an element and press it natively. */
export async function press(body: BodyApp, selector: string, pick: { index: number } | { text: string }): Promise<void> {
  await aim(body, selector, pick);
  await body.nativeClickAtElement(TARGET_SEL);
}

/** The attribute {@link sectionRect} stamps on a section, holding its title, so a press can be scoped to it. */
export const SECTION = "data-sc-section";
/** The selector for the section titled `title`, once {@link sectionRect} has measured it. */
export const sectionSel = (title: string): string => `[${SECTION}=${JSON.stringify(title)}]`;

/** The `.cg-section` whose title is `title`, stamped with {@link SECTION}, as a rect in body points; null when absent. */
export function sectionRect(body: BodyApp, title: string): Promise<Rect | null> {
  return body.evalJS<Rect | null>(
    `(function () {
      var sections = Array.prototype.slice.call(document.querySelectorAll(".cg-section"));
      var s = sections.find(function (el) { var t = el.querySelector(".cg-section-title"); return t !== null && (t.textContent || "").trim() === ${JSON.stringify(title)}; });
      if (!s) return null;
      s.setAttribute(${JSON.stringify(SECTION)}, ${JSON.stringify(title)});
      var r = s.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
}

/** Scroll the section titled `title` to the top of the card's scroller. */
export async function scrollSectionToTop(body: BodyApp, title: string): Promise<void> {
  const ok = await body.evalJS<boolean>(
    `(function () {
      var sections = Array.prototype.slice.call(document.querySelectorAll(".cg-section"));
      var s = sections.find(function (el) { var t = el.querySelector(".cg-section-title"); return t !== null && (t.textContent || "").trim() === ${JSON.stringify(title)}; });
      if (!s) return false;
      s.scrollIntoView({ block: "start" });
      return true;
    })()`,
  );
  expect(ok, `a section to scroll to: ${title}`).toBe(true);
}

/** The sections named, measured, each one expected to be in the card. */
export async function sectionRects(body: BodyApp, titles: string[]): Promise<Rect[]> {
  const rects: Rect[] = [];
  for (const title of titles) {
    const r = await sectionRect(body, title);
    expect(r, `the section "${title}" is in the card`).not.toBeNull();
    rects.push(r!);
  }
  return rects;
}

/** A body rect carried into the window's content points. */
export function inWindow(view: Rect, r: Rect): Rect {
  return { x: view.x + r.x, y: view.y + r.y, width: r.width, height: r.height };
}

/** Type `text` as a person would: a word at a time, `wordMs` apart. ASCII only. */
export async function typeSlowly(app: App, text: string, wordMs = 90): Promise<void> {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    await app.nativeType(i === 0 ? words[i]! : ` ${words[i]!}`);
    await Bun.sleep(wordMs);
  }
}

// ---- The shared Bash turn -------------------------------------------------

const IPC_VERSION = 2;
/** The stub's pace: fast, since the turn lands before the burst starts. */
const PACE_MS = 120;
const PROJECT_NAME = "tug-site";
const BOUND_MS = 30_000;
export const BLOCKS = '[data-slot="bash-tool-block"]';

/** The turn: a build, a diff, a type check that fails. */
export const BASH_CALLS: ReadonlyArray<{ command: string; beats: number; output: string; isError: boolean }> = [
  {
    command: "pnpm astro build 2>&1 | tail -6",
    beats: 3,
    output: [
      "[build] Building static entrypoints...",
      "[build] ✓ Completed in 1.12s.",
      "[build] Rearranging server assets...",
      "[build] 19 page(s) built in 1.64s",
      "[build] Complete!",
    ].join("\n"),
    isError: false,
  },
  {
    command: "git show HEAD -- src/styles/global.css",
    beats: 2,
    output: [
      "commit 1863009d71a4c0f2e8b7d6c5a4b3f2e1d0c9b8a7",
      "Author: Ken Kocienda <kocienda@mac.com>",
      "Date:   Sat Oct 24 16:02:11 2026 -0700",
      "",
      "    site(tug-home): unify subheading and split spacing",
      "",
      "diff --git a/src/styles/global.css b/src/styles/global.css",
      "index 3f1c2a9..8d4e7b1 100644",
      "--- a/src/styles/global.css",
      "+++ b/src/styles/global.css",
      "@@ -212,6 +212,9 @@",
      " .prose { min-width: 0; overflow-wrap: anywhere; }",
      "-.prose .tug-other-cards { margin-bottom: 0; }",
      "+.prose .tug-subheading { margin-top: 3rem; margin-bottom: 0.875rem; }",
      "+.prose .tug-split { margin-top: 1.25em; margin-bottom: 1.25em; }",
      "+.prose .tug-subheading + * { margin-top: 0; }",
    ].join("\n"),
    isError: false,
  },
  {
    command: "pnpm tsc --noEmit 2>&1 | tail -4",
    beats: 3,
    output: [
      "src/components/Clip.astro:41:7 - error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
      "",
      "Found 1 error in src/components/Clip.astro:41",
    ].join("\n"),
    isError: true,
  },
];

/**
 * A one-up Session card deck, `size` points, for the scenes that record a
 * transcript. The default is as tall as the window allows, so the turn's
 * three blocks fit the transcript with two of them open.
 */
export function sessionDeck(cardId: string, size: { width: number; height: number } = { width: 760, height: 1000 }): Record<string, unknown> {
  return {
    cards: [{ id: cardId, componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: `${cardId}-pane`,
        position: { x: 40, y: 40 },
        size,
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: `${cardId}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The stub transcript: one turn of {@link BASH_CALLS}, each call opening, beating and returning. */
export function bashTurnTranscript(): unknown {
  const outputs: unknown[] = [];
  BASH_CALLS.forEach((call, i) => {
    const id = `toolu_sc_comp_${i + 1}`;
    outputs.push({ type: "tool_use", msg_id: "stub-sc-comp-m1", seq: i, tool_name: "Bash", tool_use_id: id, input: { command: call.command }, ipc_version: IPC_VERSION });
    for (let b = 1; b <= call.beats; b++) {
      outputs.push({ type: "tool_progress", tool_use_id: id, tool_name: "Bash", elapsed_time_seconds: Math.round((b * PACE_MS) / 1000), parent_tool_use_id: null, ipc_version: IPC_VERSION });
    }
    outputs.push({ type: "tool_result", tool_use_id: id, output: call.output, is_error: call.isError, ipc_version: IPC_VERSION });
  });
  outputs.push({ type: "turn_complete", msg_id: "stub-sc-comp-m1", seq: BASH_CALLS.length, result: "success", ipc_version: IPC_VERSION });
  return { schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION, tugcodeVersion: "stub", paceMs: PACE_MS, turns: [{ index: 0, description: "a build, a diff and a type check", outputs }] };
}

/** Bind the card to a fresh stub session whose transcript is `transcript`, and wait for the transcript to mount. */
export async function bindStub(app: App, cardId: string, stubDir: string, transcript: unknown, prefix = "sc-comp-"): Promise<void> {
  const tugSessionId = randomUUID();
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  onTestRunEnd(() => rmSync(scratch, { recursive: true, force: true }));
  const projectDir = join(scratch, PROJECT_NAME);
  mkdirSync(projectDir);
  writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript));
  await app.spawnSessionNew(cardId, { tugSessionId, projectDir });
  await pollFor(
    () =>
      app
        .body(cardId)
        .evalJS<boolean>(`document.querySelector('[data-testid="session-card-transcript"]') !== null && document.querySelector('.session-card-picker-form') === null`)
        .catch(() => false),
    (bound) => bound,
    BOUND_MS,
  );
}

/** Send `prompt` and wait for every block of {@link BASH_CALLS} to land, then a beat for the turn to end. */
export async function runBashTurn(body: BodyApp, prompt: string): Promise<void> {
  await body.driveSession({ op: "send", text: prompt });
  await pollFor(() => body.evalJS<number>(`document.querySelectorAll(${JSON.stringify(BLOCKS)}).length`).catch(() => 0), (n) => n >= BASH_CALLS.length, 30_000);
  await Bun.sleep(1_500);
}

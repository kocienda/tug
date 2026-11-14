/**
 * vd-canvas.test.ts — the video's canvas sequence, timed to the narration in
 * the `vids` repo (`incoming/the-canvas-audio.mp4`): the whole window from
 * "…that lays out a deck of cards" (3.0 s) to "…focus on my work" (28.2 s),
 * in one burst of one launch.
 *
 * A video tool, not a test of the app: it stages a scene and records it,
 * and its assertions are that frames were written and the deck ended where
 * the scene says. It lives beside the site's drivers and shares their
 * helpers and gate (`../site-clips/_site-clips.ts`): run by path, once per
 * mode, with `TUG_SITE_CLIPS_OUT` and `TUG_SITE_CLIPS_MODE` set. The `vids`
 * repo's `tools/shot.py canvas` is the usual caller, and its
 * `tools/assemble.py canvas` lays the frames under the narration.
 *
 * The scene: a four-up under Flow at Slim width with both factory rails
 * up, holding two Session cards resumed from committed transcripts, a
 * Harbor file, and the app's icon in a viewer card — a deck of cards for AI
 * coding sessions, text files, images. The window is the screen's width
 * and View › Zoom is 80 %, so all four slots stand side by side under Flow
 * and a card sent elsewhere leaves its empty column in view, between live
 * cards. A card moves about every two seconds, each move a card seen
 * travelling. Every act is placed at a narration time, in seconds of
 * audio, and the burst subtracts its offset:
 *
 *   "divided into columns"          ⌘4: session B flies from slot 2 onto
 *                                   the image in slot 4; a hole opens mid-row
 *   "called slots"                  ⌃⌘/ splits slot 4: image above, B below
 *   "every card lives in a slot"    ⌘2: B flies back into the hole
 *   "auto-arranges and reflows"     the image card is dragged by its title
 *                                   bar onto the file card; the drop splits
 *                                   slot 3, file above, image below
 *   "so I don't have to"            session A folds, and unfolds
 *   "move cards around"             ⌘1 sends the image onto A; ⌘4 sends it
 *                                   home, and every slot is filled again
 *   "stay organized… focus"         Fit for a beat, and back to Flow
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { copyFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { App } from "../_harness";
import { settleFor } from "../body-grounding/_bodies";
import { standUpKind } from "../body-grounding/_kind-bodies";
import { cardKind, kindPane } from "../body-grounding/_kinds";
import { SPLIT } from "../slot-split-fixture";
import { seedFixtureSession } from "../fixtures/resolve";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "../site-clips/_placeholders";
import { factoryRails, railsEnv, standUpRails } from "../site-clips/_rails";
import { MODE, RUNS, contentSize, expectRecorded, launchForMode, outDirFor, scene, standIns } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 300_000;

/** The narration's window: the burst starts at "that lays out" and ends after "focus on my work". */
const CLIP_AT = 3.0;
const CLIP_END = 28.2;

/** Across the 3200 × 1800 screen, as tall as its menu bar allows (a hair under 16:9): 6160 × 3464 pixels at 2×, scaled to 3840 × 2160 by assemble.py. */
const CONTENT_SIZE = { width: 3080, height: 1732 };
/** View › Zoom, so four Slim cards and both rails fit the band under Flow. */
const PAGE_ZOOM = 0.8;

const RAIL_PREFIX = "vd-rail";
const S1 = { id: "vd-cv-s1", session: "pickerKeys" } as const satisfies Placeholder;
const FILE = { id: "vd-cv-file", file: "tides.ts" } as const satisfies Placeholder;
const S2 = "vd-cv-s2";
const IMAGE = "vd-cv-image";
/** The second Session card's transcript and the identity its masthead shows. */
const S2_FIXTURE = "session-task-run-fold";
const S2_IDENTITY = { name: "edge-insert", name_user_set: true, tag: "teal-otter", synopsis: "Add the Edge Insert effect with an Overlap slider" };
const S2_FACTS = { turn_count: 4, file_size: 139_045, last_used_at: Date.UTC(2026, 10, 6, 21, 40) };
/** The image: the app's own icon, copied into the Harbor project so the masthead reads a short path. */
const ICON = resolve(import.meta.dir, "..", "..", "..", "resources", "AppIcon-1024b.png");

const CMD = ["cmd"] as const;
const CARD_IMG = '[data-slot="file-view-card"] img.tugx-image-img';
const GRAB_HANDLE = ".tug-pane-title-bar .tug-pane-grab-handle";
const BOUND_MS = 60_000;

/** The drag's pace, as `sc-card-move` drags: the press, then steps × delay. */
const PRESS_MS = 120;
const DRAG_STEPS = 24;
const DRAG_STEP_MS = 30;

function deck(): Record<string, unknown> {
  const rails = factoryRails(RAIL_PREFIX);
  return {
    cards: [
      placeholderCard(S1),
      { id: S2, componentId: "session", title: S2_IDENTITY.name, closable: true },
      placeholderCard(FILE),
      { id: IMAGE, componentId: "file-view", title: "tug.png", closable: true },
      ...rails.cards,
    ],
    panes: [kindPane("session", S1.id, 0), kindPane("session", S2, 1), kindPane("text", FILE.id, 2), kindPane("file-view", IMAGE, 3), ...rails.panes],
    activePaneId: `${S1.id}-pane`,
    imposition: { kind: "four-up", layout: "flow", contentWidth: "slim", sidebars: rails.sidebars, rails: rails.rails },
    hasFocus: true,
  };
}

/** Resume the second session's transcript into its card, wait for it to settle, and publish its identity (as `_placeholders.ts` does for its own). */
async function bindSecondSession(app: App): Promise<void> {
  const tugSessionId = randomUUID();
  const seeded = await seedFixtureSession(S2_FIXTURE, `video-${S2}`, { sessionId: tugSessionId });
  const deadline = Date.now() + BOUND_MS;
  while (!(await app.bodies()).some((b) => b.cardId === S2 && b.state === "ready")) {
    if (Date.now() > deadline) throw new Error(`${S2}: no ready body within ${BOUND_MS} ms`);
    await Bun.sleep(100);
  }
  const body = app.body(S2);
  await app.spawnSessionResume(S2, { tugSessionId, projectDir: seeded.projectDir });
  const host = `[data-card-id="${S2}"] [data-testid="session-card-transcript"]`;
  const scroller = `[data-card-id="${S2}"] [data-tug-scroll-key="session-card-transcript"]`;
  await body.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(host)}) !== null && document.querySelector('[data-card-id="${S2}"] .session-card-picker-form') === null`,
    { timeoutMs: BOUND_MS },
  );
  await body.waitForCondition<boolean>(
    `(function(){
      var host = document.querySelector(${JSON.stringify(host)});
      var el = document.querySelector(${JSON.stringify(scroller)});
      if (host === null || el === null || host.hasAttribute("data-replaying")) return false;
      var seen = window.__tugVideoSettle || (window.__tugVideoSettle = {});
      var now = performance.now(), last = seen[${JSON.stringify(S2)}];
      if (last === undefined || last.height !== el.scrollHeight) {
        seen[${JSON.stringify(S2)}] = { height: el.scrollHeight, at: now };
        return false;
      }
      return now - last.at >= 500;
    })()`,
    { timeoutMs: BOUND_MS },
  );
  const row = { session_id: tugSessionId, project_dir: seeded.projectDir, ...S2_IDENTITY, ...S2_FACTS };
  const push = `window.__tug.publishSessionUpdated(${JSON.stringify(JSON.stringify({ session_id: tugSessionId, fields: row }))})`;
  await app.evalJS<boolean>(push);
  for (const b of await app.bodies()) {
    if (b.state === "ready" && b.cardId !== null) await app.body(b.cardId).evalJS<boolean>(push);
  }
  const masthead = `(document.querySelector('[data-slot="session-masthead"]') || { textContent: "" }).textContent || ""`;
  await settleFor(() => body.evalJS<string>(masthead), (t) => t.includes(S2_IDENTITY.name), 5_000);
}

/** Where to press `cardId`'s grab handle, in window points, as it stands now. */
async function grabPoint(app: App, cardId: string): Promise<{ x: number; y: number }> {
  const handle = await app.elementRect(cardId, GRAB_HANDLE);
  if (handle === null) throw new Error(`${cardId} offers no grab handle`);
  return { x: handle.x + Math.min(20, handle.width / 2), y: handle.y + handle.height / 2 };
}

/** Drag `cardId` by its title bar and drop it on `onto`, below that card's title band so the drop asks for its slot. */
async function dragOnto(app: App, cardId: string, onto: string): Promise<void> {
  const from = await grabPoint(app, cardId);
  const rest = await standIns(app);
  const target = rest[onto];
  if (target === undefined) throw new Error(`${onto} has no stand-in to drop on`);
  const to = { x: target.x + target.width / 2, y: from.y + 120 };
  await app.nativeDragWithoutRelease(from, to, { interpolationSteps: DRAG_STEPS, interpolationDelayMs: DRAG_STEP_MS, mouseDownDelayMs: PRESS_MS });
  await app.nativeMouseUp(to);
}

describe.skipIf(!RUNS)("video: the canvas sequence", () => {
  test(
    "records cards moving between slots, a drag, stacks and splits, a fold, and Fit and Flow, timed to the narration",
    async () => {
      const settings = placeholderSettings();
      const project = settings.find(([, key]) => key === "default-project-path")![2];
      const imagePath = join(project, "tug.png");
      copyFileSync(ICON, imagePath);

      const app = await launchForMode("vd-canvas", deck(), undefined, {
        contentSize: CONTENT_SIZE,
        env: railsEnv(),
        cardStates: { ...placeholderStates([S1, FILE]), [IMAGE]: { content: { path: imagePath } } },
        settings,
      });
      try {
        const granted = await app.setWindowContentSize(CONTENT_SIZE);
        expect(granted, "the display grants the window").toEqual(CONTENT_SIZE);
        await app.setPageZoom(PAGE_ZOOM);
        await standUpRails(app, RAIL_PREFIX);
        await standUpPlaceholders(app, [S1, FILE]);
        await bindSecondSession(app);
        const viewer = await standUpKind(app, cardKind("file-view"), IMAGE);
        await viewer.waitForCondition<boolean>(
          `(function(){ var el = document.querySelector(${JSON.stringify(CARD_IMG)}); return el !== null && el.naturalWidth > 0; })()`,
          { timeoutMs: 20_000 },
        );
        await app.dispatchControlAction("focus-pane", { paneId: `${S1.id}-pane` });
        await Bun.sleep(1_500);
        const rest = await standIns(app);
        for (const id of [S1.id, S2, FILE.id, IMAGE]) expect(rest[id], `${id} stands in the deck`).toBeDefined();
        expect(rest[IMAGE]!.x + rest[IMAGE]!.width, "all four slots stand inside the window").toBeLessThanOrEqual(CONTENT_SIZE.width);

        const A = (audioSecs: number) => Math.round((audioSecs - CLIP_AT) * 1000);
        const focus = (cardId: string) => () => app.dispatchControlAction("focus-pane", { paneId: `${cardId}-pane` });
        const layout = (to: "fit" | "flow") => () => app.dispatchControlAction("set-imposition-layout", { layout: to });
        const key = (k: string, mods: readonly ("cmd" | "ctrl" | "shift")[]) => () => app.nativeKey(k, mods);

        // A chord acts on the focused card, and a focus asked in the same
        // breath as the chord lands late, so each focus is placed a beat early.
        const s = scene().mark("loop-start", 0);
        // "…divided into columns": ⌘4 sends session B onto the image; the column it left stands empty, mid-row.
        s.at(A(9.0), focus(S2));
        s.at(A(9.4), key("4", CMD));
        // "…called slots": ⌃⌘/ splits slot 4, image above, B below.
        s.at(A(11.6), key("/", SPLIT));
        // "…and every card lives in a slot": ⌘2 sends B back into the hole.
        s.at(A(13.3), key("2", CMD));
        // "Tug auto-arranges and reflows the cards": the image is dragged by its title bar onto the file card, and the drop splits that slot: file above, image below.
        s.at(A(15.5), () => dragOnto(app, IMAGE, FILE.id));
        // "…so I don't have to": session A folds, and unfolds.
        s.at(A(18.4), focus(S1.id));
        s.at(A(18.8), () => app.performMenuItem("view.foldCard"));
        s.at(A(20.3), () => app.performMenuItem("view.foldCard"));
        // "…commands and keyboard shortcuts to move cards around": ⌘1 sends the image onto A, ⌘4 sends it home; every slot is filled again.
        s.at(A(20.9), focus(IMAGE));
        s.at(A(21.3), key("1", CMD));
        s.at(A(22.6), key("4", CMD));
        // "This scheme helps me stay organized and focus on my work": Fit for a beat, then back to Flow, the default.
        s.at(A(24.8), layout("fit"));
        s.at(A(26.4), layout("flow"));
        s.mark("loop-end", A(CLIP_END));
        const reading = await s.record(app, { outDir: outDirFor("canvas"), settleMs: 300 });
        expectRecorded(reading);

        const after = await standIns(app);
        for (const id of [S1.id, S2, FILE.id, IMAGE]) expect(after[id], `${id} stands in the deck`).toBeDefined();
        expect(after[IMAGE]!.x, "the image is home in the last slot").toBeGreaterThan(after[FILE.id]!.x);
        writeFileSync(
          join(outDirFor("canvas"), "shot.json"),
          JSON.stringify({ shot: "canvas", mode: MODE, audioOffsetSecs: CLIP_AT, audioEndSecs: CLIP_END, contentSize: await contentSize(app), marks: reading.marks, frames: reading.frames, scale: reading.scale }, null, 2),
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

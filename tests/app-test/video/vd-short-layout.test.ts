/**
 * vd-short-layout.test.ts — a YouTube Short on card layout: every card in a
 * numbered slot, files opened into the deck, a card sent onto another by
 * ⌘-number to make a stack, the stack stepped through, the slot split so
 * both cards show, a card folded to its masthead, and the card sent home.
 *
 * A video tool, not a test of the app: it stages a scene and records it, and
 * its assertions are that frames were written and the deck ended where the
 * scene says. It is `vd-canvas.test.ts` re-cut for a Short and shares its
 * helpers and gate: run by path with `TUG_SITE_CLIPS_OUT` and
 * `TUG_SITE_CLIPS_MODE` set; with either unset it skips. The `vids` repo's
 * `tools/shot.py short-layout` is the usual caller, and its `tools/short.py`
 * composes the portrait frame.
 *
 * The scene: a four-up under Fit at Slim width with no rails, holding two
 * Session cards resumed from committed transcripts, the third and fourth
 * slots empty. The window is sized so the four slots fill it. Something
 * moves from the first frame: the camera opens on the two sessions and
 * pulls out while two Harbor files arrive in the empty slots, and no
 * stretch after that stands still for two seconds.
 *
 * A card opened on camera stands for a few frames as a blank lid with a
 * progress wave while its body loads, and the video must not show that: a
 * card arrives whole. So both files are opened before the main burst, and a
 * short burst of the deck before they opened (`short-layout-empty`) gives
 * the composer the empty canvas to lay over each file's slot until its
 * moment (`covers` in `shot.json`: a rect in window points, the second it
 * lifts, and its fade).
 *
 * The frame is portrait and the picture is not: the composer (a `landscape`
 * recipe) keeps the whole window across the frame's width, with the room
 * under it left for captions, and moves a camera inside that picture between
 * the views this driver writes to `shot.json` (`camera`: a view per beat, in
 * window points, with the seconds its move runs over). A key press is not a
 * thing a viewer can see, so each chord is also written as `caps` (the keys,
 * and the seconds they show for), which the composer draws under the picture.
 *
 * The times are seconds of a draft read of the narration; they are re-timed
 * to the recording's word timestamps once there is one.
 *
 * @visible
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type { App } from "../_harness";
import { settleFor } from "../body-grounding/_bodies";
import { kindPane } from "../body-grounding/_kinds";
import { seedFixtureSession } from "../fixtures/resolve";
import { placeholderCard, placeholderSettings, placeholderStates, standUpPlaceholders, type Placeholder } from "../site-clips/_placeholders";
import { MODE, RUNS, contentSize, expectRecorded, launchForMode, outDirFor, scene, standIns } from "../site-clips/_site-clips";

const TEST_TIMEOUT_MS = 300_000;
const SHOT = "short-layout";

/** A window a little wider than 3:2, so the picture is about 750 px tall in the 1080-wide frame. */
const CONTENT_SIZE = { width: 2200, height: 1500 };
/** View › Zoom, so four Slim cards stand side by side in the window under Fit. */
const PAGE_ZOOM = 0.75;

const S1 = { id: "vd-ly-s1", session: "pickerKeys" } as const satisfies Placeholder;

const S2 = "vd-ly-s2";
/** The second Session card's transcript and the identity its masthead shows. */
const S2_FIXTURE = "session-task-run-fold";
const S2_IDENTITY = { name: "edge-insert", name_user_set: true, tag: "teal-otter", synopsis: "Add the Edge Insert effect with an Overlap slider" };
const S2_FACTS = { turn_count: 4, file_size: 139_045, last_used_at: Date.UTC(2026, 10, 6, 21, 40) };
/** The files that arrive on camera, in order. */
const OPENED = ["tides.ts", "notes.md"] as const;
/** A cover lifts over this long: the card fades in whole. */
const COVER_FADE = 0.2;
/** A cover reaches this far past its card's rect, in points, over the focus ring. */
const COVER_MARGIN = 10;

const BOUND_MS = 60_000;

/** The beats, in seconds of the draft read. */

const T = {
  /** "With AI coding, I've got sessions and files open everywhere. I don't want to spend my day arranging windows": the camera pulls out from the two sessions while two files open into the empty slots, then the second file is sent onto the first session, a stack. */
  pull: [0.0, 3.0],
  opens: [0.3, 1.6],
  stackUp: 3.4,
  /** "In Tug, every card lives in a numbered slot, and Tug does the arranging": in on the mastheads' badges, and slowly closer. */
  badgesIn: [5.2, 6.2],
  tight: [6.4, 10.2],
  /** "Cards that share a slot make a stack, and I flip through it from the keyboard." */
  steps: [10.6, 12.0],
  out: [13.2, 14.2],
  /** "Or I split the slot, and see them both." */
  split: 14.8,
  near: [16.0, 19.4],
  /** "I can fold a card down to its title…" */
  fold: 17.6,
  unfold: 19.6,
  wide: [20.6, 21.6],
  /** "…and send it back to a slot of its own." */
  home: 22.4,
  /** "I stay organized without even trying. That's Tug": a slow push to the end. */
  last: [23.6, 29.5],
  end: 29.5,
} as const;

/** A cap shows from this long before its key, so the eye is on it when the deck answers, to this long after, or until the next chord's cap takes its place. */
const CAP_LEAD = 0.6;
const CAP_AFTER = 1.5;

function deck(): Record<string, unknown> {
  return {
    cards: [placeholderCard(S1), { id: S2, componentId: "session", title: S2_IDENTITY.name, closable: true }],
    panes: [kindPane("session", S1.id, 0), kindPane("session", S2, 1)],
    activePaneId: `${S1.id}-pane`,
    imposition: { kind: "four-up", layout: "fit", contentWidth: "slim", sidebars: {}, rails: { left: { order: [] }, right: { order: [] } } },
    hasFocus: true,
  };
}

/** Resume the second session's transcript into its card, wait for it to settle, and publish its identity (as `vd-canvas.test.ts` does). */
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

describe.skipIf(!RUNS)("video shot: the card-layout Short", () => {
  test(
    "records two files opening into the deck, a stack made and stepped through, a split, a fold, and the card sent home",
    async () => {
      const settings = placeholderSettings();
      const project = settings.find(([, key]) => key === "default-project-path")![2];

      const app = await launchForMode("vd-short-layout", deck(), undefined, {
        contentSize: CONTENT_SIZE,
        cardStates: placeholderStates([S1]),
        settings,
      });
      try {
        const granted = await app.setWindowContentSize(CONTENT_SIZE);
        expect(granted, "the display grants the window").toEqual(CONTENT_SIZE);
        await app.setPageZoom(PAGE_ZOOM);
        await standUpPlaceholders(app, [S1]);
        await bindSecondSession(app);
        await app.dispatchControlAction("focus-pane", { paneId: `${S2}-pane` });
        await Bun.sleep(1_500);
        const rest = await standIns(app);
        for (const id of [S1.id, S2]) expect(rest[id], `${id} stands in the deck`).toBeDefined();
        const window = await contentSize(app);
        const notes: Record<string, unknown> = { rest };

        // ---- The deck before the files open: a short burst, for the empty canvas the composer covers their slots with. ----
        await scene().mark("loop-start", 0).mark("loop-end", 300).record(app, { outDir: outDirFor(`${SHOT}-empty`), settleMs: 300 });

        // ---- The files, opened and loaded before the first frame; the second, in the last slot, is the card the scene moves about. ----
        const fileCards: string[] = [];
        for (const name of OPENED) {
          await app.dispatchControlAction("open-file", { path: join(project, name) });
          const deadline = Date.now() + 20_000;
          let found: string | undefined;
          while (found === undefined) {
            if (Date.now() > deadline) throw new Error(`${name}: no card within 20 s`);
            await Bun.sleep(150);
            found = Object.keys(await standIns(app)).find((id) => id !== S1.id && id !== S2 && !fileCards.includes(id));
          }
          fileCards.push(found);
          await Bun.sleep(2_000);
        }
        const notesCard = fileCards[1]!;
        const opened = await standIns(app);
        notes.afterOpen = opened;
        const covers = fileCards.map((id, i) => {
          const r = opened[id]!;
          return { rect: { x: r.x - COVER_MARGIN, y: r.y - COVER_MARGIN, width: r.width + 2 * COVER_MARGIN, height: r.height + 2 * COVER_MARGIN }, until: T.opens[i]!, fade: COVER_FADE };
        });
        // The second file took the focus when it opened and keeps it through the scene: every chord below acts on it.
        // (An opened card's pane is not named for the card, so `focus-pane` cannot be asked for it by id.)
        await Bun.sleep(1_000);

        const ms = (secs: number) => Math.round(secs * 1000);
        const caps: { keys: string[]; label: string; from: number; to: number }[] = [];
        /** The cap for a chord pressed at `secs`, with the few words that say what it does. */
        const cap = (secs: number, keys: string[], label: string) => caps.push({ keys, label, from: secs - CAP_LEAD, to: secs + CAP_AFTER });
        /** A chord at `secs`, with its cap. */
        const chord = (s: ReturnType<typeof scene>, secs: number, k: string, mods: readonly ("cmd" | "ctrl" | "alt")[], keys: string[], label: string) => {
          cap(secs, keys, label);
          s.at(ms(secs), () => app.nativeKey(k, mods));
        };

        // ---- The views, in window points: a corner and a width; the composer gives each the picture's own shape. ----
        const views: Record<string, { x: number; y: number; width: number }> = {
          whole: { x: 0, y: 0, width: window.width },
          // The two sessions and the edge of the third slot, where the first file lands.
          first: { x: 0, y: 0, width: window.width * 0.62 },
          // The first two slots' mastheads, where the slot badges are, and the same a little closer.
          badges: { x: 0, y: 0, width: window.width * 0.5 },
          tight: { x: 0, y: 0, width: window.width * 0.42 },
          // The deck's left from its top, where a folded card's masthead stands: the first slot split in two, and the cards beside it.
          near: { x: 0, y: 0, width: window.width * 0.86 },
        };
        const camera = [
          { view: "first", from: 0, to: 0 },
          { view: "whole", from: T.pull[0], to: T.pull[1] },
          { view: "badges", from: T.badgesIn[0], to: T.badgesIn[1] },
          { view: "tight", from: T.tight[0], to: T.tight[1] },
          { view: "whole", from: T.out[0], to: T.out[1] },
          { view: "near", from: T.near[0], to: T.near[1] },
          { view: "whole", from: T.wide[0], to: T.wide[1] },
          { view: "near", from: T.last[0], to: T.last[1] },
        ];

        // ---- The burst. A chord acts on the focused card, and a focus asked in the same breath lands late, so each is placed a beat early. ----
        const s = scene().mark("loop-start", 0);

        // ⌘1 sends it onto session A: two cards in slot 1, a stack.
        chord(s, T.stackUp, "1", ["cmd"], ["⌘", "1"], "Move card to slot 1");
        // ⌥⌘] steps through the stack: session A to the front, then the file again.
        for (const at of T.steps) chord(s, at, "]", ["alt", "cmd"], ["⌥", "⌘", "]"], "Next card in stack");
        // ⌃⌘/ splits the slot: both cards in view.
        chord(s, T.split, "/", ["ctrl", "cmd"], ["⌃", "⌘", "/"], "Split slot");
        s.at(ms(T.near[0]), async () => {
          notes.afterSplit = await standIns(app);
        });
        // The file folds to its masthead, and unfolds.

        cap(T.fold, ["⌃", "⌘", "Y"], "Fold card");
        cap(T.unfold, ["⌃", "⌘", "Y"], "Unfold card");
        s.at(ms(T.fold), () => app.performMenuItem("view.foldCard"));
        s.at(ms(T.fold) + 1_000, async () => {
          notes.afterFold = await standIns(app);
        });
        s.at(ms(T.unfold), () => app.performMenuItem("view.foldCard"));
        // ⌘4 sends the file home: every slot holds one card again.

        chord(s, T.home, "4", ["cmd"], ["⌘", "4"], "Move card to slot 4");
        // One cap at a time: a cap leaves when the next one arrives.
        caps.sort((a, b) => a.from - b.from);
        caps.forEach((c, i) => {
          const next = caps[i + 1];
          if (next !== undefined && c.to > next.from) c.to = next.from;
        });
        s.mark("loop-end", ms(T.end));
        const reading = await s.record(app, { outDir: outDirFor(SHOT), settleMs: 300 });

        const after = await standIns(app);
        notes.after = after;
        writeFileSync(
          join(outDirFor(SHOT), "shot.json"),
          JSON.stringify({ shot: SHOT, mode: MODE, pageZoom: PAGE_ZOOM, contentSize: window, views, camera, caps, covers, cover: `${SHOT}-empty`, marks: reading.marks, frames: reading.frames, scale: reading.scale, notes }, null, 2),
        );
        expectRecorded(reading);
        for (const id of [S1.id, S2]) expect(after[id], `${id} stands in the deck`).toBeDefined();
        expect(Object.keys(after).length, "both files opened as cards").toBe(4);
        expect(after[S1.id]!.x, "session A is home in the first slot").toBeLessThan(after[S2]!.x);
        expect(after[notesCard]!.x, "the second file is home in the last slot").toBeGreaterThan(after[fileCards[0]!]!.x);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

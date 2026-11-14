/**
 * at0816-rail-reskin-reading.test.ts — the shared rail never clears and never
 * wears the wrong theme across a switch between workspaces of different
 * themes.
 *
 * The rail is the window's and follows the shown workspace's theme. A rail
 * card's page is another process and cannot re-skin inside the cut's
 * transaction, so the host tells each live rail page the arriving theme at
 * the gesture, changes nothing on screen, and makes the cut when every one
 * has answered. Two workspaces, one on a dark theme and one on a light one,
 * are switched between from the Window menu's rows six times, the host's
 * layer rows sampled across each switch. In every sampled frame no rail
 * card's picture is a skeleton, and no rail card is live in a theme other
 * than the shown stage's for more than one sampled frame: a page's answer
 * and the host's cut are two processes' commits, and can land a frame apart.
 * The theme a row carries is the one the page last said it wears, which it
 * says ahead of the frame it draws in it. So a seventh switch is read off
 * the screen instead: composited window captures every 16 ms, each rail
 * card's own pixels classed dark or light beside the arriving card's, and
 * the frames in which a rail card and the deck disagree counted. The
 * captures are not synced to the display, so the bound there is two
 * frames, and the count is noted.
 *
 * The rail holds the kinds the user's does, and its Overview a feed of 150
 * posts, the one rail card whose page is heavy enough to matter to a
 * re-skin. Noted beside the assertions: how long each cut was held, and the
 * host's `rail re-skin` line for each card, told the theme to its answer.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugdeck/src/body/body-main.ts
 * @covers tugdeck/src/lib/window-rail.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import type { BodyLayersReading, CaptureBurstReading } from "../_harness/client";
import { decodePngFile, type DecodedPng } from "../_harness/png";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "../body-grounding/_bodies";
import { cardsOf, layoutOf, RAIL, space, type Space } from "./_workspace-deck";
import { POST_COUNT, wirePost } from "../overview-window-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const SWITCHES = 6;
const LAYERS_MS = 600;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

const SPACES: Space[] = [space("g816", "dark", ["text", "text"]), space("g816", "light", ["text"])];
const THEMES = ["ironclad", "sloop"];
const BURST_MS = 500;
/**
 * The most captured frames a rail card's pixels may disagree with the deck's
 * across a cut: the one frame two processes' commits can land apart, and one
 * for a capture that falls between them.
 */
const OFF_THEME_FRAMES = 2;

/**
 * Whether the image is light around content point (`x`, `y`): the majority
 * of five pixels along a row, so a glyph's stroke under one does not decide.
 */
function lightAt(img: DecodedPng, scale: number, x: number, y: number): boolean {
  let light = 0;
  for (const dx of [-16, -8, 0, 8, 16]) {
    const px = Math.min(img.width - 1, Math.max(0, Math.round((x + dx) * scale)));
    const py = Math.min(img.height - 1, Math.max(0, Math.round(y * scale)));
    const i = (py * img.width + px) * 4;
    if (0.2126 * img.rgba[i] + 0.7152 * img.rgba[i + 1] + 0.0722 * img.rgba[i + 2] >= 128) light += 1;
  }
  return light >= 3;
}

function stats(xs: readonly number[]): string {
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  return `median ${Math.round(s[Math.floor((s.length - 1) / 2)])}, max ${Math.round(s[s.length - 1])}`;
}

/** The host's `rail re-skin` lines so far: the card, told to answered, and the page's own time to apply, ms. */
function reskinLines(log: string): { card: string; ms: number; applied: number }[] {
  const out: { card: string; ms: number; applied: number }[] = [];
  for (const line of log.split("\n")) {
    const m = / rail re-skin card=(\S+) theme=\S+ ms=(\S+) applied=(\S+)/.exec(line);
    if (m !== null) out.push({ card: m[1], ms: Number(m[2]), applied: Number(m[3]) });
  }
  return out;
}

describe.skipIf(!SHOULD_RUN)("at0816 — the shared rail's re-skin", () => {
  test(
    "six cross-theme switches: no rail card stands a skeleton or wears the wrong theme",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const layout = layoutOf(SPACES) as { spaces: Record<string, unknown>[] };
      layout.spaces[0].theme = THEMES[0];
      layout.spaces[1].theme = THEMES[1];
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layout));
      const app = await launchTugApp({
        testName: "at0816-rail-reskin-reading",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const rail = SPACES[0].rail;
        for (const id of cardsOf(SPACES[0])) {
          await settleFor(() => bodyOf(app, id), (x) => x?.state === "ready" && x.painted === true, 30_000);
        }
        // The Overview's feed, delivered as the window files deliver theirs:
        // with the column hidden, so it has no window to hold post by post,
        // then shown to mount its window once over the whole feed.
        const overview = app.body(rail[RAIL.findIndex((r) => r.kind === "overview")]);
        const column = `document.querySelector('[data-testid="overview-transcript"]')`;
        await overview.waitForCondition<boolean>(`${column} !== null`, { timeoutMs: 10_000 });
        await overview.evalJS<boolean>(`(${column}.style.display = "none", true)`);
        // Ten posts to an eval: one eval carrying all of them never answers.
        let fed = 0;
        for (let from = 0; from < POST_COUNT; from += 10) {
          const posts = Array.from({ length: Math.min(10, POST_COUNT - from) }, (_, i) => JSON.stringify(wirePost(from + i)));
          fed += await overview.evalJS<number>(
            `${JSON.stringify(posts)}.filter(function (p) { return window.__tug.publishOverviewPost(p); }).length`,
          );
        }
        expect(fed, "the Overview took its feed").toBe(POST_COUNT);
        await overview.waitForCondition<boolean>(`(window.__tug.overviewPosts() || []).length === ${POST_COUNT}`, { timeoutMs: 10_000 });
        await overview.evalJS<boolean>(`(${column}.style.display = "", true)`);
        await overview.waitForCondition<boolean>(
          `${column}.hasAttribute("data-window-peak") && !${column}.hasAttribute("data-window-stale")`,
          { timeoutMs: 10_000 },
        );
        const held: number[] = [];
        for (let n = 0; n < SWITCHES; n++) {
          const row = n % 2 === 0 ? 1 : 0;
          const to = SPACES[row];
          await app.bodyLayers({ op: "arm", windowMs: LAYERS_MS });
          await app.performMenuItem(`window.space.${row}`);
          const active = await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === to.id, 10_000);
          expect(active, `switch ${n + 1} reaches ${to.id}`).toBe(to.id);
          const layers = (await settleFor(
            () => app.bodyLayers({ op: "read" }) as Promise<BodyLayersReading>,
            (x) => x.done === true,
            LAYERS_MS + 10_000,
          )) as BodyLayersReading;
          const cut = (await app.stages()).cuts.at(-1);
          expect(cut?.to, `switch ${n + 1} was the host's cut`).toBe(to.id);
          if (cut !== undefined) held.push(cut.committedWall - cut.gestureWall);
          const parts: string[] = [];
          for (const [i, r] of RAIL.entries()) {
            const rows = layers.rows.filter((x) => x.cardId === rail[i]);
            expect(rows.length, `${r.kind}: sampled across switch ${n + 1}`).toBeGreaterThan(0);
            const skeletons = rows.filter((x) => x.picture === "skeleton").length;
            const wrong = rows.filter(
              (x) => x.picture === "live" && typeof x.theme === "string" && typeof x.stageTheme === "string" && x.theme !== x.stageTheme,
            ).length;
            parts.push(`${r.kind} ${rows.length} frames, ${wrong} off-theme`);
            expect(skeletons, `${r.kind}: no skeleton over the rail in switch ${n + 1}`).toBe(0);
            expect(wrong, `${r.kind}: frames live in a theme other than the shown stage's, switch ${n + 1}`).toBeLessThanOrEqual(1);
            expect(rows.at(-1)?.theme, `${r.kind}: wears the arriving theme after switch ${n + 1}`).toBe(THEMES[row]);
            expect(rows.at(-1)?.stageTheme, `the shown stage's theme after switch ${n + 1}`).toBe(THEMES[row]);
          }
          note(`switch ${n + 1} → ${to.id}: held ${cut === undefined ? "?" : Math.round(cut.committedWall - cut.gestureWall)} ms; ${parts.join(", ")}`);
          await Bun.sleep(300);
        }
        note(`cuts held for the rail: ${stats(held)} ms`);

        // The seventh switch, dark to light, read off the screen.
        const size = await app.evalJS<{ width: number; height: number }>(`({ width: window.innerWidth, height: window.innerHeight })`);
        const dir = join(tmpdir(), `at0816-${Date.now()}`);
        mkdirSync(dir, { recursive: true });
        await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: 16, crop: { x: 0, y: 0, ...size }, outDir: dir });
        // A few frames of the departing deck before the gesture, so the
        // change itself is inside the frames read.
        await Bun.sleep(100);
        await app.captureBurst({ op: "mark", name: "gesture" });
        await app.performMenuItem("window.space.1");
        const burst = (await settleFor(
          () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
          (x) => x.done,
          BURST_MS + 10_000,
        )) as CaptureBurstReading;
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === SPACES[1].id, 10_000);
        const deckCard = await settleFor(() => bodyOf(app, SPACES[1].content[0].id), (x) => x?.visible === true, 10_000);
        expect(deckCard?.visible, "the arriving card is shown").toBe(true);
        const deckAt = { x: deckCard!.frame.x + deckCard!.frame.width / 4, y: deckCard!.frame.y + deckCard!.frame.height / 2 };
        const railAt: { kind: string; x: number; y: number }[] = [];
        for (const [i, r] of RAIL.entries()) {
          const b = await bodyOf(app, rail[i]);
          if (b !== null) railAt.push({ kind: r.kind, x: b.frame.x + b.frame.width / 2, y: b.frame.y + b.frame.height - 40 });
        }
        const marked = burst.frames.findIndex((f) => f.index >= (burst.marks.gesture ?? 0));
        const frames = burst.frames.map((f) => decodePngFile(f.path));
        const deck = frames.map((img) => lightAt(img, burst.scale, deckAt.x, deckAt.y));
        const face = (xs: boolean[]) => xs.map((x) => (x ? "L" : "D")).join("");
        note(`captured switch, deck: ${face(deck)} (${frames.length} frames, the gesture at frame ${marked})`);
        expect(deck[0], "the deck was dark before the gesture").toBe(false);
        expect(deck.at(-1), "the deck arrived light").toBe(true);
        for (const p of railAt) {
          const mine = frames.map((img) => lightAt(img, burst.scale, p.x, p.y));
          const off = mine.filter((x, i) => x !== deck[i]).length;
          note(`captured switch, ${p.kind}: ${face(mine)} (${off} frames off the deck's theme)`);
          expect(mine.at(-1), `${p.kind}: arrived light`).toBe(true);
          expect(off, `${p.kind}: captured frames in which the rail and the deck disagree`).toBeLessThanOrEqual(OFF_THEME_FRAMES);
        }

        const log = app.tugappLog();
        const logged = reskinLines(log);
        for (const [i, r] of RAIL.entries()) {
          const mine = logged.filter((x) => x.card === rail[i]);
          note(
            `${r.kind} re-skin, host's line (${mine.length}/${SWITCHES}): told→answered ${stats(mine.map((x) => x.ms))} ms; ` +
              `page told→applied ${stats(mine.map((x) => x.applied))}`,
          );
          expect(mine.length, `${r.kind}: the host logged its re-skin`).toBeGreaterThan(0);
        }
        const late = log.split("\n").filter((line) => line.includes("rail re-skin past its horizon"));
        expect(late, "no rail card kept a cut waiting to its horizon").toEqual([]);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

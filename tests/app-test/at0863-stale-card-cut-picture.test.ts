/**
 * at0863-stale-card-cut-picture.test.ts — what a Session card whose session
 * moved while its workspace was hidden shows at the cut back.
 *
 * Two workspaces: home with one Text card, away with a Text card and a
 * Session card bound to a stubbed session (`streaming-stub-fixture.ts`). The
 * Session card is shown and painted and the keyboard is left with its Text
 * neighbour, so leaving the workspace moves nothing the Session card draws:
 * a page says stale once in a hidden period, and the keyboard leaving a key
 * card would spend that word before its last frame is taken. The deck goes
 * home, and the host takes the parked card's last frame. Then a prompt is
 * sent into the hidden card: its session starts a turn, its `activity` moves
 * in its own deck entry, and its page says `bodyStale`. A parked page keeps
 * painting until it is declared dormant, so it has drawn the move by the
 * time the deck cuts back to away.
 *
 * Read across the cut: the picture the host's `stages` account records for
 * the card at the cut; the card's picture on every host frame from the cut
 * (`bodyLayers`); and a burst of window captures cropped to the card's
 * content box, each frame from the cut's commit on classed blank — one flat
 * colour, a skeleton's body — or drawn. The host's `picture down` line for
 * the card, which says how long its picture stood, is noted from the log.
 *
 * Asserts that the page said stale for `deckCards.activity` while hidden,
 * that the host heard it, that the cut onto its workspace was made, and that
 * the card arrived as its own live page: its picture at the cut is `live`,
 * no host frame shows a skeleton, and no window frame over it is blank.
 *
 * @covers tugapp/Sources/BodyStages.swift
 * @covers tugdeck/src/body/body-staleness.ts
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";
import type { BodyLayersReading, CaptureBurstReading } from "./_harness/client";
import { decodePngFile } from "./_harness/png";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "./_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "./body-grounding/_bodies";
import { contentOf, paneRect } from "./body-grounding/_row-44";
import { deckOf, space } from "./readings/_workspace-deck";
import { bindStreamingStubs, STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
const BURST_MS = 800;
const BURST_INTERVAL_MS = 16;
const LAYERS_MS = 1_200;
/** A frame this much one colour across the card's content box is a blank pane. */
const BLANK_SHARE = 0.995;
/** A channel this close to the commonest colour's is that colour: a flat fill is dithered by one. */
const NEAR = 3;
/** Pixels between samples, each way. */
const STRIDE = 3;

const HOME = space("g863", "home", ["text"]);
const AWAY = space("g863", "away", ["text", "session"]);
const TEXT = HOME.content[0].id;
const NEIGHBOUR = AWAY.content[0].id;
const SESSION = AWAY.content[1].id;

/** One letter per read: L live, F last frame, S skeleton, - none. */
const mark = (p: string | null | undefined): string => (p === "live" ? "L" : p === "lastFrame" ? "F" : p === "skeleton" ? "S" : "-");

/** The share of a frame's sampled pixels that are its most common colour, or within `NEAR` of it. */
function modalShare(path: string): number {
  const img = decodePngFile(path);
  const counts = new Map<number, number>();
  const keys: number[] = [];
  for (let y = 0; y < img.height; y += STRIDE) {
    for (let x = 0; x < img.width; x += STRIDE) {
      const i = (y * img.width + x) * 4;
      const key = (img.rgba[i] << 16) | (img.rgba[i + 1] << 8) | img.rgba[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      keys.push(key);
    }
  }
  if (keys.length === 0) return 1;
  let modal = 0;
  let most = 0;
  for (const [key, count] of counts) if (count > most) [modal, most] = [key, count];
  const near = (key: number): boolean => [16, 8, 0].every((s) => Math.abs(((key >> s) & 0xff) - ((modal >> s) & 0xff)) <= NEAR);
  let share = 0;
  for (const [key, count] of counts) if (near(key)) share += count;
  return share / keys.length;
}

describe.skipIf(!SHOULD_RUN)("at0863 — a card whose session moved while hidden, at the cut back", () => {
  test(
    "the hidden card says stale for its activity, and the cut back never shows it as a blank pane",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      const layout = {
        version: 5,
        activeSpaceId: HOME.id,
        spaces: [
          { id: HOME.id, name: "Home", deck: deckOf(HOME) },
          { id: AWAY.id, name: "Away", deck: deckOf(AWAY) },
        ],
      };
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layout));
      const stubDir = stubDirectory();
      const app = await launchTugApp({
        testName: "at0863-stale-card-cut-picture",
        env: { TUGBANK_PATH: tugbankPath, [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const go = async (id: string): Promise<void> => {
          await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(id)} }), null)`);
          await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (x) => x === id, 5_000);
        };
        const shown = (id: string) => settleFor(() => bodyOf(app, id), (b) => b?.state === "ready" && b.painted === true && b.visible === true, 30_000);

        // Show the Session card, bind it, and let it paint.
        await shown(TEXT);
        await go(AWAY.id);
        await shown(SESSION);
        await bindStreamingStubs(app, [SESSION], stubDir);
        await app.dispatchControlAction("focus-session-card", { cardId: NEIGHBOUR });
        const key = await settleFor(() => app.getFocusedCardId(), (id) => id === NEIGHBOUR, 3_000);
        expect(key, "the keyboard is with the Session card's neighbour before the workspace is left").toBe(NEIGHBOUR);
        const pane = await settleFor(() => paneRect(app, SESSION), (r) => r !== null, 5_000);
        expect(pane, "the Session card's pane has a box").not.toBeNull();
        const box = contentOf(pane!);
        await Bun.sleep(300);

        // Park it, and wait for its last frame.
        await go(HOME.id);
        const parked = await settleFor(() => app.stages(), (s) => s.parkCovers.cards[SESSION] !== undefined, 8_000);
        note(`parked: last frame ${parked.parkCovers.cards[SESSION] === undefined ? "not taken" : `taken, ${parked.parkCovers.cards[SESSION].bytes} bytes`}`);

        // Its session moves while it is hidden.
        const logAt = app.tugappLog().length;
        const sent = Date.now();
        await app.driveSession(SESSION, { op: "send", text: "Walk the module and report each pass." });
        const readStale = (): Promise<{ parts: string[]; at: number } | null> =>
          app
            .body(SESSION)
            .evalJS<{ parts: string[]; at: number } | null>("window.__tugBodyStale === undefined ? null : window.__tugBodyStale", { timeoutMs: 1_000 })
            .catch(() => null);
        const stale = await settleFor(readStale, (s) => s !== null && s.at >= sent, 10_000);
        const hostStale = await settleFor(
          async () => app.tugappLog().slice(logAt).includes(`: stale while painting, kept card=${SESSION}`),
          (seen) => seen,
          3_000,
        );
        note(
          `hidden: the page said stale for ${stale === null ? "nothing" : `${stale.parts.join(", ")}, ${stale.at >= sent ? `${stale.at - sent} ms after` : `${sent - stale.at} ms before`} the prompt`}; ` +
            `the host heard it and kept the page as its picture: ${hostStale}`,
        );
        const before = (await app.stages()).parkCovers.cards[SESSION];
        const saidStale = (): string[] =>
          app
            .tugappLog()
            .slice(logAt)
            .split("\n")
            .filter((l) => l.includes(`kept card=${SESSION}`) || l.includes(`: stale card=${SESSION}`))
            .map((l) => l.slice(l.indexOf("class=")));
        note(`before the cut: last frame ${before === undefined ? "dropped" : "kept"}; the host heard: ${saidStale().join("; ") || "nothing"}`);

        // Cut back, reading every host frame and a burst of window frames over the card.
        const outDir = join(tmpdir(), `at0863-frames-${Date.now()}`);
        await app.bodyLayers({ op: "arm", windowMs: LAYERS_MS });
        await app.captureBurst({ op: "arm", durationMs: BURST_MS, intervalMs: BURST_INTERVAL_MS, crop: box, outDir });
        await app.captureBurst({ op: "mark", name: "gesture" });
        const cut = Date.now();
        await go(AWAY.id);
        const burst = (await settleFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, BURST_MS + 5_000)) as CaptureBurstReading;
        const layers = (await settleFor(() => app.bodyLayers({ op: "read" }) as Promise<BodyLayersReading>, (r) => r.done, LAYERS_MS + 5_000)) as BodyLayersReading;
        const record = (await app.stages()).cuts.filter((c) => c.to === AWAY.id && c.gestureWall >= cut - 50).at(-1) ?? null;

        const picture = record?.pictures[SESSION] ?? null;
        note(`the card's picture at the cut: ${picture ?? "none recorded"}`);
        const rows = layers.rows.filter((r) => r.cardId === SESSION && record !== null && r.wall >= record.committedWall).sort((a, b) => a.wall - b.wall);
        const skeletonRows = rows.filter((r) => r.picture === "skeleton");
        note(`host frames from the cut: ${rows.map((r) => mark(r.picture)).join("")}`);
        note(
          `host frames showing a skeleton: ${skeletonRows.length} of ${rows.length}` +
            (skeletonRows.length === 0 || record === null ? "" : `, the last ${Math.round(skeletonRows[skeletonRows.length - 1].wall - record.committedWall)} ms after the cut`),
        );
        // From the cut's commit on: before it the window shows the workspace being left.
        const committed = record?.committedWall ?? Infinity;
        const frames = burst.frames.filter((f) => f.wall >= committed).map((f) => ({ wall: f.wall, share: modalShare(f.path) }));
        const blank = frames.filter((f) => f.share >= BLANK_SHARE);
        note(
          `window frames over the card from the cut (first ${frames.length === 0 ? "none" : `${Math.round(frames[0].wall - committed)} ms after it`}), B blank, d drawn: ` +
            frames.map((f) => (f.share >= BLANK_SHARE ? "B" : "d")).join(""),
        );
        note(
          `window frames blank: ${blank.length} of ${frames.length}` +
            (blank.length === 0 ? "" : `, the last ${Math.round(blank[blank.length - 1].wall - committed)} ms after the cut`) +
            `, under ${outDir}`,
        );
        await settleFor(async () => (await app.stages()).stages.flatMap((s) => s.cards).find((c) => c.cardId === SESSION)?.picture, (p) => p === "live", 3_000);
        const down = app
          .tugappLog()
          .slice(logAt)
          .split("\n")
          .filter((l) => l.includes(`picture down card=${SESSION}`));
        note(`the host's dwell line: ${down.length === 0 ? "none" : down.map((l) => l.slice(l.indexOf("picture down"))).join("; ")}`);

        expect(stale !== null && stale.at >= sent ? stale.parts : [], "the hidden page said stale for its session's activity, after the prompt").toContain("deckCards.activity");
        expect(hostStale, "the host heard the parked page say stale, and kept the page as its picture").toBe(true);
        expect(record?.to, "the cut onto the card's workspace was made").toBe(AWAY.id);
        expect(picture, "the card's picture at the cut is its live page").toBe("live");
        expect(skeletonRows.length, "no host frame from the cut shows a skeleton for the card").toBe(0);
        expect(frames.length, "window frames were captured from the cut on").toBeGreaterThan(0);
        expect(blank.length, "no window frame over the card from the cut on is a blank pane").toBe(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

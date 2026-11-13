/**
 * at0812-switch-cut-reading.test.ts — what each switch between made-ahead
 * workspaces waits on, on a deck shaped like the user's.
 *
 * Five workspaces under the window's one rail of five cards
 * (`_workspace-deck.ts`); the content is Text and unbound Session cards, so
 * nothing spawns. After launch the reading waits until every parked
 * workspace's pages are made ahead, then switches 20 times, cycling the
 * five, with a rest between, under the host's layer sampler and the deck
 * trace. Per switch it notes the host's cut as `stages()` records it — the
 * door it came through, the gesture to its committed transaction, and the
 * picture each arriving card stood as at the cut — beside the trace's
 * `space-switch-timing` record (the swap's commit, the session restore, the
 * switch's whole task, and the paint after it), and how many layer rows show
 * a departing content card's page after the cut committed.
 *
 * Three of the switches are also recorded frame by frame
 * (`AT0812_FRAMES_DIR`, else the temp directory), and every frame from the
 * gesture to 400 ms past the cut's commit is read, per Text card content
 * box of both workspaces (a Session card's picker fills in live, and the
 * rail is the window's, whose Layout and Cards cards follow the arriving
 * workspace after the cut by design), against the frame before the gesture and the switch's settled
 * frame: a box unlike both, unless its card stands under its own last frame
 * (the host's park cover, which an arriving page that has not confirmed
 * wears), or a frame with some boxes still the departed workspace's and
 * others already the arriving one's, is a mixed frame. And
 * the shell's make-ahead pauses are read: each switch paused it, and it asked
 * for no page while paused.
 *
 * The numbers are noted, not barred, and kept as JSON (`AT0812_OUT`, else
 * the temp directory) for the arc's reading. What is asserted is that all
 * 20 switches ran, that no recorded frame is mixed, and that make-ahead
 * asked for nothing through a switch.
 *
 * @covers tugapp/Sources/BodyStages.swift
 * @covers tugdeck/src/lib/body-shell.ts
 * @covers tugdeck/src/lib/body-make-ahead.ts
 * @covers tugdeck/src/lib/cards-selection-store.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyLayerRow, BodyLayersReading, CaptureBurstReading, StageCutRecord } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "../body-grounding/_bodies";
import { contentOf, paneRect, type Rect } from "../body-grounding/_row-44";
import { cardsOf, layoutOf, space, type Space } from "./_workspace-deck";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
const SWITCHES = 20;
const REST_MS = 1_500;
/** How long each switch's layer rows are sampled: inside the rest. */
const LAYERS_MS = 800;
/** How long the parked workspaces have to be made ahead after home has painted. */
const AHEAD_MS = 90_000;
/** The switches recorded frame by frame, 0-based: three different pairs of workspaces. */
const BURST_AT = new Set([5, 11, 17]);
/** A recorded switch's frames: every 33 ms over 1.2 s, inside the rest. */
const FRAMES_MS = 1_200;
const FRAMES_INTERVAL_MS = 33;
/** How long past the cut's commit a recorded switch's frames are read. */
const MIXED_AFTER_CUT_MS = 400;
/** How much of a content box may differ from a reference frame and still be that frame. */
const SAME_SHARE = 0.002;

const HOME = space("r812", "home", ["text", "session"]);
const SPACES: Space[] = [
  HOME,
  space("r812", "a", ["text", "text", "session"]),
  space("r812", "b", ["session", "text", "text"]),
  space("r812", "c", ["text", "session", "text"]),
  space("r812", "d", ["text", "text"]),
];

/** The cards a workspace's pages are made ahead for: every card but its Session cards, which a reading need not wait on. */
const aheadOf = (s: Space): string[] => [...s.rail, ...s.content.filter((c) => c.kind === "text").map((c) => c.id)];
/** A workspace's own Text cards: the boxes a recorded frame is read by, since the rail belongs to no workspace. */
const framedOf = (s: Space): string[] => s.content.filter((c) => c.kind === "text").map((c) => c.id);

const TRACE_READ = (mark: number): string =>
  `JSON.stringify(window.__deckTrace.since(${mark}).filter(function (e) { return e.kind === "space-switch-timing"; }))`;

interface SwitchTiming {
  toSpaceId: string;
  commitMs: number;
  restoreMs: number;
  totalMs: number;
  paintMs: number;
}

interface SwitchReading {
  index: number;
  from: string;
  to: string;
  /** The host's cut onto `to`, or null when none was recorded. */
  cut: StageCutRecord | null;
  trace: SwitchTiming | null;
  /** Layer rows after the cut committed that show a departing content card's page. */
  departedShown: number;
}

const r = (v: number | null | undefined): string => (v === null || v === undefined ? "none" : `${Math.round(v)}`);

function stats(xs: readonly number[]): string {
  if (xs.length === 0) return "none";
  const s = [...xs].sort((a, b) => a - b);
  return `median ${Math.round(s[Math.floor((s.length - 1) / 2)])}, max ${Math.round(s[s.length - 1])}`;
}

/** Wait until every card in `ids` has a ready, painted body, shown or not as `shown` says. */
async function made(app: App, ids: readonly string[], shown: boolean, timeoutMs: number): Promise<number> {
  const at = Date.now();
  let count = 0;
  for (const id of ids) {
    const left = Math.max(1_000, timeoutMs - (Date.now() - at));
    const b = await settleFor(() => bodyOf(app, id), (s) => s?.state === "ready" && s.painted === true && s.visible === shown, left);
    if (b?.state === "ready" && b.painted === true && b.visible === shown) count += 1;
  }
  return count;
}

type Png = ReturnType<typeof decodePngFile>;

const inside = (r: Rect, x: number, y: number): boolean => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

/** The share of `box`'s pixels (backing px), outside every `mask`, that differ between two decoded frames by more than a hair. */
function differingShare(p: Png, q: Png, box: Rect, masks: readonly Rect[] = []): number {
  let differing = 0;
  let n = 0;
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(p.height, Math.ceil(box.y + box.height)); y += 2) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(p.width, Math.ceil(box.x + box.width)); x += 2) {
      if (masks.some((m) => inside(m, x, y))) continue;
      const i = (y * p.width + x) * 4;
      n += 1;
      if ([0, 1, 2].some((c) => Math.abs(p.rgba[i + c] - q.rgba[i + c]) > 8)) differing += 1;
    }
  }
  return differing / Math.max(1, n);
}

/** The whole panes, in backing px, of those of `ids` the shell shows now. */
async function panesOf(app: App, ids: readonly string[], scale: number): Promise<Rect[]> {
  const out: Rect[] = [];
  for (const id of ids) {
    const pane = await paneRect(app, id);
    if (pane !== null) out.push({ x: pane.x * scale, y: pane.y * scale, width: pane.width * scale, height: pane.height * scale });
  }
  return out;
}

/** A workspace's Session cards: their pickers fill in live, so their panes are read by no box. */
const sessionsOf = (s: Space): string[] => s.content.filter((c) => c.kind === "session").map((c) => c.id);

/** The content boxes, in backing px, of those of `ids` the shell shows now. */
async function boxesOf(app: App, ids: readonly string[], scale: number): Promise<[string, Rect][]> {
  const out: [string, Rect][] = [];
  for (const id of ids) {
    const pane = await paneRect(app, id);
    if (pane === null) continue;
    const c = contentOf(pane);
    out.push([id, { x: c.x * scale, y: c.y * scale, width: c.width * scale, height: c.height * scale }]);
  }
  return out;
}

/**
 * Each recorded frame from `cut` to `until`, as one letter: `D` every box
 * still the departed frame's, `A` every box the settled arriving frame's,
 * `M` mixed — a box unlike both, or some boxes departed and others arrived.
 * A box alike to both says nothing; a box unlike both whose card the host's
 * layer rows show under its last frame at that moment is the arriving card's
 * own last frame, and counts as arrived. Pixels inside a `masks` rect are
 * read by no box. With the mixed frames named.
 */
function readFrames(
  frames: CaptureBurstReading,
  cut: number,
  until: number,
  boxes: readonly [string, Rect][],
  masks: readonly Rect[],
  rows: readonly BodyLayerRow[],
): { letters: string; mixed: string[]; lastFrames: number } {
  const before = frames.frames.filter((f) => f.wall < cut).at(-1);
  const settled = frames.frames.at(-1);
  if (before === undefined || settled === undefined) return { letters: "", mixed: ["no frames either side of the gesture"], lastFrames: 0 };
  /** Whether `cardId` stood under its last frame at `wall`: its latest layer row by then says so. */
  const underLastFrame = (cardId: string, wall: number): boolean =>
    rows.filter((r) => r.cardId === cardId && r.wall <= wall).at(-1)?.lastFrame === true;
  let lastFrames = 0;
  const departed = decodePngFile(before.path);
  const arrived = decodePngFile(settled.path);
  let letters = "";
  const mixed: string[] = [];
  for (const f of frames.frames.filter((f) => f.wall >= cut && f.wall <= until)) {
    const png = decodePngFile(f.path);
    const neither: string[] = [];
    const asDeparted: string[] = [];
    const asArrived: string[] = [];
    for (const [id, box] of boxes) {
      const d = differingShare(png, departed, box, masks) <= SAME_SHARE;
      const a = differingShare(png, arrived, box, masks) <= SAME_SHARE;
      const name = id.replace(/r812-/g, "");
      if (!d && !a && id.split("+").some((one) => underLastFrame(one, f.wall))) {
        lastFrames += 1;
        asArrived.push(name);
      } else if (!d && !a) neither.push(name);
      else if (d && !a) asDeparted.push(name);
      else if (a && !d) asArrived.push(name);
    }
    const isMixed = neither.length > 0 || (asDeparted.length > 0 && asArrived.length > 0);
    letters += isMixed ? "M" : asArrived.length > 0 ? "A" : "D";
    if (isMixed) {
      mixed.push(
        `frame ${f.index} (${Math.round(f.wall - cut)} ms): ` +
          [neither.length > 0 ? `neither ${neither.join(",")}` : "", asDeparted.length > 0 && asArrived.length > 0 ? `departed ${asDeparted.join(",")} beside arrived ${asArrived.join(",")}` : ""]
            .filter((s) => s !== "")
            .join("; "),
      );
    }
  }
  return { letters, mixed, lastFrames };
}

/** One make-ahead pause, as the shell keeps it (`body-make-ahead.ts`). */
interface AheadPause {
  spaceId: string;
  pausedAt: number;
  resumedAt: number | null;
  why: string | null;
  asked: number;
}

/** How many of a cut's arriving cards stood as each picture. */
function picturesOf(c: StageCutRecord): string {
  const all = Object.values(c.pictures);
  return (["live", "lastFrame", "skeleton"] as const).map((k) => `${k} ${all.filter((p) => p === k).length}`).join(", ");
}

describe.skipIf(!SHOULD_RUN)("at0812 — what a switch between made-ahead workspaces waits on", () => {
  test(
    "20 switches on a user-shaped deck, each switch's cut and timing noted",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(layoutOf(SPACES)));
      const out = process.env.AT0812_OUT ?? join(tmpdir(), "at0812-switch-cut-reading.json");
      const app = await launchTugApp({
        testName: "at0812-switch-cut-reading",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        const total = SPACES.reduce((n, s) => n + cardsOf(s).length, 0);
        note(`deck: ${SPACES.length} workspaces, ${total} cards`);
        const homePainted = await made(app, aheadOf(HOME), true, 60_000);
        note(`home: ${homePainted}/${aheadOf(HOME).length} pages painted`);
        const aheadStart = Date.now();
        const parked = SPACES.slice(1).flatMap(framedOf);
        const aheadCount = await made(app, parked, false, AHEAD_MS);
        note(`made ahead: ${aheadCount}/${parked.length} parked pages ready and painted in ${Math.round((Date.now() - aheadStart) / 1000)} s`);

        const mark = await app.evalJS<number>("(window.__deckTrace.enable(true), window.__deckTrace.mark())");
        const readings: SwitchReading[] = [];
        const framesRoot = process.env.AT0812_FRAMES_DIR ?? join(tmpdir(), "at0812-switch-frames");
        const recorded: { index: number; to: string; dir: string; letters: string; mixed: string[]; gestureAt: number; committedAt: number | null }[] = [];
        const cuts: number[] = [];
        let current = HOME.id;
        for (let i = 0; i < SWITCHES; i++) {
          const to = SPACES[(i + 1) % SPACES.length];
          const from = SPACES.find((s) => s.id === current) as Space;
          // The rail is the window's and stays: only the content departs.
          const departing = new Set(from.content.map((c) => c.id));
          const burst = BURST_AT.has(i);
          const framesDir = join(framesRoot, `switch-${i + 1}`);
          let departedBoxes: [string, Rect][] = [];
          let departedSessions: Rect[] = [];
          let scale = 1;
          if (burst) {
            mkdirSync(framesDir, { recursive: true });
            scale = await app.evalJS<number>("window.devicePixelRatio");
            departedBoxes = await boxesOf(app, framedOf(from), scale);
            departedSessions = await panesOf(app, sessionsOf(from), scale);
            const width = await app.evalJS<number>("window.innerWidth");
            const height = await app.evalJS<number>("window.innerHeight");
            await app.captureBurst({ op: "arm", durationMs: FRAMES_MS, intervalMs: FRAMES_INTERVAL_MS, crop: { x: 0, y: 0, width, height }, outDir: framesDir });
          }
          await app.bodyLayers({ op: "arm", windowMs: LAYERS_MS });
          await Bun.sleep(30);
          const cut = Date.now();
          cuts.push(cut);
          await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(to.id)} }), null)`);
          await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === to.id, 5_000);
          await Bun.sleep(REST_MS);
          const record = (await app.stages()).cuts.filter((c) => c.to === to.id && c.gestureWall >= cut - 50).at(-1) ?? null;
          const committed = record?.committedWall ?? cut;
          const layers = (await settleFor(
            () => app.bodyLayers({ op: "read" }) as Promise<BodyLayersReading>,
            (x) => x.done,
            LAYERS_MS + 5_000,
          )) as BodyLayersReading;
          // A departing page on screen once the cut has committed is a fault;
          // before it, the departed workspace is still the one shown.
          const departedShown = layers.rows.filter(
            (row: BodyLayerRow) => departing.has(row.cardId) && row.wall > committed && !row.hidden && row.opacity > 0,
          ).length;
          const traces = JSON.parse(await app.evalJS<string>(TRACE_READ(mark))) as SwitchTiming[];
          const trace = traces.filter((t) => t.toSpaceId === to.id).at(-1) ?? null;
          readings.push({ index: i + 1, from: current, to: to.id, cut: record, trace, departedShown });
          if (burst) {
            const frames = (await settleFor(
              () => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>,
              (x) => x.done,
              FRAMES_MS + 10_000,
            )) as CaptureBurstReading;
            // A departing and an arriving card in the same pane are one region, read once and named for both.
            const boxes: [string, Rect][] = [];
            for (const [id, box] of [...departedBoxes, ...(await boxesOf(app, framedOf(to), frames.scale || scale))]) {
              const same = boxes.findIndex(([, b]) => Math.abs(b.x - box.x) < 4 && Math.abs(b.y - box.y) < 4 && Math.abs(b.width - box.width) < 4 && Math.abs(b.height - box.height) < 4);
              if (same < 0) boxes.push([id, box]);
              else boxes[same] = [`${boxes[same][0]}+${id}`, boxes[same][1]];
            }
            const masks = [...departedSessions, ...(await panesOf(app, sessionsOf(to), frames.scale || scale))];
            const read = readFrames(frames, cut, committed + MIXED_AFTER_CUT_MS, boxes, masks, layers.rows);
            const at = (wall: number): number => frames.frames.findIndex((f) => f.wall >= wall);
            recorded.push({ index: i + 1, to: to.id, dir: framesDir, letters: read.letters, mixed: read.mixed, gestureAt: at(cut), committedAt: record === null ? null : at(committed) });
            note(
              `switch ${i + 1} frames (${frames.frames.length} in ${framesDir}, gesture at frame ${at(cut)}, cut committed at frame ${record === null ? "none" : at(committed)}): ` +
                `${read.letters}; ${read.lastFrames} boxes under their last frame${read.mixed.length > 0 ? ` — mixed: ${read.mixed.join("; ")}` : ""}`,
            );
          }
          note(
            `switch ${i + 1} → ${to.id}: ` +
              (record === null
                ? "no cut recorded"
                : `cut by ${record.door}, committed ${r(record.committedWall - record.gestureWall)} ms after the gesture; ${picturesOf(record)}`) +
              ` | trace ${trace === null ? "none" : `commit ${r(trace.commitMs)} restore ${r(trace.restoreMs)} total ${r(trace.totalMs)} paint ${r(trace.paintMs)}`}` +
              ` | departed shown ${departedShown} rows after the cut`,
          );
          current = to.id;
        }

        // What made each page stale in its last hidden period: the signature parts that moved (`body-staleness.ts`).
        const staleParts: Record<string, number> = {};
        for (const id of SPACES.flatMap(cardsOf)) {
          const read = await app
            .body(id)
            .evalJS<{ parts: string[] } | null>("window.__tugBodyStale ?? null", { timeoutMs: 1_000 })
            .catch(() => null);
          for (const part of read?.parts ?? []) staleParts[part] = (staleParts[part] ?? 0) + 1;
        }
        note(`stale parts, pages naming each: ${Object.entries(staleParts).map(([k, n]) => `${k} ${n}`).join("; ") || "none"}`);
        const cutRecords = readings.map((x) => x.cut).filter((c): c is StageCutRecord => c !== null);
        const pictureCount = (kind: string): number[] => cutRecords.map((c) => Object.values(c.pictures).filter((p) => p === kind).length);
        const traces = readings.map((x) => x.trace).filter((t): t is SwitchTiming => t !== null);
        note(`cuts: ${cutRecords.length}/${SWITCHES} recorded; doors ${["menu", "page", "shell"].map((d) => `${d} ${cutRecords.filter((c) => c.door === d).length}`).join(", ")}`);
        note(`cut committed ms ${stats(cutRecords.map((c) => c.committedWall - c.gestureWall))}`);
        note(`pictures at the cut: live ${stats(pictureCount("live"))}; lastFrame ${stats(pictureCount("lastFrame"))}; skeleton ${stats(pictureCount("skeleton"))}`);
        // The parked account against its budget: what a last frame for every page of this deck costs.
        const parkCovers = (await app.stages()).parkCovers;
        const perCover = Object.values(parkCovers.cards).map((c) => c.bytes);
        const mb = (bytes: number): string => `${(bytes / (1 << 20)).toFixed(1)} MB`;
        note(`park covers: ${perCover.length} kept of ${SPACES.flatMap(cardsOf).length} pages; per cover ${perCover.length === 0 ? "none" : `median ${mb([...perCover].sort((a, b) => a - b)[Math.floor(perCover.length / 2)])}, max ${mb(Math.max(...perCover))}`}; total ${mb(parkCovers.bytes)} against a ${mb(parkCovers.budgetBytes)} budget`);
        note(`trace commit ${stats(traces.map((t) => t.commitMs))}; restore ${stats(traces.map((t) => t.restoreMs))}; total ${stats(traces.map((t) => t.totalMs))}; paint ${stats(traces.map((t) => t.paintMs))}`);
        note(`switches showing a departed page after the cut: ${readings.filter((x) => x.departedShown > 0).length}`);
        // Make-ahead through the switches: each paused it, and it asked for nothing while paused.
        const pauses = (await app.evalJS<AheadPause[] | null>("window.__tugMakeAhead ? window.__tugMakeAhead.pauses : null")) ?? [];
        const unpaused = cuts.filter((cut) => !pauses.some((p) => p.pausedAt >= cut - 50 && p.pausedAt <= cut + 1_000)).length;
        const askedThrough = pauses.reduce((n, p) => n + p.asked, 0);
        const pausedMs = pauses.filter((p) => p.resumedAt !== null).map((p) => (p.resumedAt as number) - p.pausedAt);
        note(
          `make-ahead pauses: ${pauses.length} kept for ${SWITCHES} switches, ${unpaused} switches with none; ` +
            `resumed ${pauses.filter((p) => p.why === "settled").length} settled, ${pauses.filter((p) => p.why === "horizon").length} at the horizon, ${pauses.filter((p) => p.resumedAt === null).length} still paused; ` +
            `paused ms ${stats(pausedMs)}; pages asked while paused ${askedThrough}`,
        );
        const mixedFrames = recorded.flatMap((x) => x.mixed.map((m) => `switch ${x.index}: ${m}`));
        writeFileSync(out, JSON.stringify({ aheadCount, parked: parked.length, readings, recorded, pauses }, null, 2));
        note(`kept in ${out}`);

        expect(readings.length, "all 20 switches ran").toBe(SWITCHES);
        expect(mixedFrames, "no recorded frame shows a mix of the two workspaces, or neither").toEqual([]);
        expect(unpaused, "every switch paused make-ahead").toBe(0);
        expect(askedThrough, "make-ahead asked for no page while a switch paused it").toBe(0);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

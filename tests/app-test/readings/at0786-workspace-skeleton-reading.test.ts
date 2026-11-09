/**
 * at0786-workspace-skeleton-reading.test.ts — what a cold workspace switch
 * looks like and costs, gesture to set landing, on a deck shaped like the
 * user's, and what the deck costs in memory at rest.
 *
 * The workspace-skeletons brief picks the set's horizon, the lane's switch
 * width and whether every parked workspace may be made ahead from these
 * numbers. The deck is shaped like the user's: every workspace stands its
 * own five rail cards (Dashes, Jots and Overview on the left, Cards and
 * Layout on the right) beside its content panes, and the content is Text and
 * Session cards — eight arriving cards in each workspace away from home. The
 * Session cards are unbound, so their pages carry no transcript: the memory
 * read here is a page's floor.
 *
 * On one launch, with the made-ahead path as it ships:
 *
 * - *Cold switch*: home to a workspace never shown, cut the moment home has
 *   painted, before the made-ahead pass's quiet second has passed, under a
 *   window capture burst kept on disk (`AT0786_FRAMES_DIR`, else the temp
 *   directory) and the host's layer rows. Per card, the cut to its first
 *   shown page and how it started; the hand-over; the reveal set's log, which
 *   says when the set landed and whether by its last paint or its horizon.
 * - *Made-ahead switch*: back home, ten seconds of rest, then to a workspace
 *   never shown whose pages the pass has made, under a second burst
 *   (`AT0786_AHEAD_FRAMES_DIR`, else the temp directory). Every frame in the
 *   first 400 ms that is no longer the departed workspace is read against
 *   the settled frame, per rail and Text card's content box (a Session
 *   card's picker fills in live): a box unlike its settled self is a frame
 *   that is neither workspace.
 * - *Memory, made ahead*: at that rest, the WebContent processes' resident
 *   total.
 * - *Warm switch*: back home, then to the same workspace again; the cut to
 *   each card's first shown page.
 * - *Memory, every workspace*: the last workspace visited once, home
 *   again, ten seconds of rest, and the total again.
 *
 * The numbers are noted, not barred. What is asserted is that the arms ran:
 * both switches' pages all showed. With every parked workspace made ahead,
 * both memory totals hold every page, so they are noted beside each other
 * and not compared.
 *
 * @covers tugapp/Sources/BodyViewController.swift
 * @covers tugapp/Sources/BodyLane.swift
 * @covers tugapp/Sources/BodyHandOver.swift
 */

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "../_harness";
import type { BodyLayerRow, BodyLayersReading, CaptureBurstFrame, CaptureBurstReading } from "../_harness/client";
import { decodePngFile } from "../_harness/png";
import { mkTempTugbank, rmTempTugbank, seedTugbankForLaunch, tugbankWrite } from "../_harness/tugbank-helpers";
import { bodyOf, pollFor, settleFor } from "../body-grounding/_bodies";
import { framesDiffer } from "../body-grounding/_frames";
import { contentOf, paneRect, type Rect } from "../body-grounding/_row-44";
import { webContentProcesses } from "../session-body-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
/** How long a switch's layer rows are read: past the set's 2000 ms horizon and the slowest cold page the user's log records. */
const LAYERS_MS = 4_500;
/** The cold switch's frames: every 33 ms over the first three seconds. */
const FRAMES_MS = 3_000;
const FRAMES_INTERVAL_MS = 33;
const REST_MS = 10_000;
const PAINT_MS = 30_000;

/** The rail kinds every workspace on the user's deck stands, and their sides. */
const RAIL = [
  { kind: "dashes", side: "left" },
  { kind: "jots", side: "left" },
  { kind: "overview", side: "left" },
  { kind: "cards", side: "right" },
  { kind: "layout", side: "right" },
] as const;

interface Space {
  id: string;
  rail: string[];
  content: { id: string; kind: "text" | "session" }[];
}

function space(tag: string, content: ("text" | "session")[]): Space {
  return {
    id: `r786-${tag}-space`,
    rail: RAIL.map((r) => `r786-${tag}-${r.kind}`),
    content: content.map((kind, i) => ({ id: `r786-${tag}-${kind}${i}`, kind })),
  };
}

const HOME = space("home", ["text"]);
const AWAY = space("away", ["text", "text", "session"]);
const THIRD = space("third", ["session", "text", "session"]);
const FOURTH = space("fourth", ["text", "session", "session"]);
const SPACES = [HOME, AWAY, THIRD, FOURTH];

const cardsOf = (s: Space): string[] => [...s.rail, ...s.content.map((c) => c.id)];

/** A workspace's deck: its rail panes, then one content pane per card, imposed side by side. */
function deckOf(s: Space): Record<string, unknown> {
  const pane = (id: string, title: string, slot?: number) => ({
    id: `${id}-pane`,
    position: { x: 60, y: 60 },
    size: { width: 600, height: 700 },
    cardIds: [id],
    activeCardId: id,
    title,
    acceptsFamilies: slot === undefined ? ([] as string[]) : ["standard"],
    ...(slot === undefined ? {} : { slot }),
  });
  const kinds = ["one-up", "one-up", "two-up", "three-up"] as const;
  return {
    cards: [
      ...RAIL.map((r, i) => ({ id: s.rail[i], componentId: r.kind, title: r.kind, closable: true })),
      ...s.content.map((c) => ({ id: c.id, componentId: c.kind, title: c.id, closable: true })),
    ],
    panes: [...RAIL.map((r, i) => pane(s.rail[i], r.kind)), ...s.content.map((c, slot) => pane(c.id, c.id, slot))],
    activePaneId: `${s.content[0].id}-pane`,
    imposition: {
      kind: kinds[Math.min(s.content.length, 3)],
      layout: "fit",
      sidebars: Object.fromEntries(RAIL.map((r) => [r.kind, { side: r.side }])),
      rails: {
        left: { order: RAIL.filter((r) => r.side === "left").map((r) => r.kind) },
        right: { order: RAIL.filter((r) => r.side === "right").map((r) => r.kind) },
      },
    },
    hasFocus: true,
  };
}

const LAYOUT = {
  version: 5,
  activeSpaceId: HOME.id,
  spaces: SPACES.map((s, i) => ({ id: s.id, name: `Space ${i + 1}`, deck: deckOf(s) })),
};

const mb = (kb: number): string => (kb / 1024).toFixed(0);
const ms = (v: number | null | undefined): string => (v === null || v === undefined ? "never" : `${Math.round(v)} ms`);

/** How long after the cut a made-ahead switch's frames are read against its settled frame. */
const TORN_MS = 400;
/** How much of a content box may differ from its settled self and still be the finished card. */
const FINISHED_SHARE = 0.002;

/** The share of `r`'s pixels (backing px) that differ between two decoded frames by more than a hair. */
function differingShare(p: ReturnType<typeof decodePngFile>, q: ReturnType<typeof decodePngFile>, r: Rect): number {
  let differing = 0;
  let n = 0;
  for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(p.height, Math.ceil(r.y + r.height)); y += 2) {
    for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(p.width, Math.ceil(r.x + r.width)); x += 2) {
      const i = (y * p.width + x) * 4;
      n += 1;
      if ([0, 1, 2].some((c) => Math.abs(p.rgba[i + c] - q.rgba[i + c]) > 8)) differing += 1;
    }
  }
  return differing / Math.max(1, n);
}

/** Each frame in the first {@link TORN_MS} past the departed workspace whose content box for one of `ids` is unlike the settled frame's. */
async function tornFrames(app: App, s: Switched, ids: readonly string[]): Promise<string[]> {
  const frames = s.frames?.frames ?? [];
  const scale = s.frames?.scale ?? 1;
  const standing: CaptureBurstFrame | undefined = frames.filter((f) => f.wall < s.cutWall).at(-1);
  const last = frames.at(-1);
  if (last === undefined) return ["no frames"];
  const settled = decodePngFile(last.path);
  const boxes: [string, Rect][] = [];
  for (const id of ids) {
    const pane = await paneRect(app, id);
    if (pane === null) continue;
    const c = contentOf(pane);
    boxes.push([id, { x: c.x * scale, y: c.y * scale, width: c.width * scale, height: c.height * scale }]);
  }
  const torn: string[] = [];
  for (const f of frames.filter((f) => f.wall >= s.cutWall && f.wall - s.cutWall <= TORN_MS && (standing === undefined || framesDiffer(f, standing)))) {
    const png = decodePngFile(f.path);
    const unlike = boxes.filter(([, box]) => differingShare(png, settled, box) > FINISHED_SHARE).map(([id]) => id);
    if (unlike.length > 0) torn.push(`frame ${f.index} (${Math.round(f.wall - s.cutWall)} ms): ${unlike.join(", ")}`);
  }
  return torn;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/** Wait until every card in `ids` is a ready, painted, shown body. */
async function allPainted(app: App, ids: readonly string[], timeoutMs = PAINT_MS): Promise<boolean> {
  const at = Date.now();
  for (const id of ids) {
    const left = Math.max(1_000, timeoutMs - (Date.now() - at));
    const b = await settleFor(() => bodyOf(app, id), (s) => s?.state === "ready" && s.painted === true && s.visible, left);
    if (b?.painted !== true || b.visible !== true) return false;
  }
  return true;
}

/** The resident total of every WebContent process, and how many there are. */
function memory(): { kb: number; count: number } {
  const ps = webContentProcesses();
  return { kb: ps.reduce((s, p) => s + p.rssKb, 0), count: ps.length };
}

/** Each card's first row from `cutWall` on that shows its own page: painted, unfaced, unhidden, opaque. */
function firstVisible(rows: readonly BodyLayerRow[], ids: readonly string[], cutWall: number): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const id of ids) {
    const row = rows
      .filter((r) => r.cardId === id && r.wall >= cutWall)
      .sort((a, b) => a.wall - b.wall)
      .find((r) => r.painted && !r.faced && !r.hidden && r.opacity > 0);
    out[id] = row === undefined ? null : row.wall - cutWall;
  }
  return out;
}

interface Switched {
  cutWall: number;
  rows: BodyLayerRow[];
  revealLog: string[];
  handOver: string;
  frames: CaptureBurstReading | null;
}

/** Switch to `spaceId` with the host's layer sampler running, and a capture burst kept in `framesDir` when one is given. */
async function readSwitchTo(app: App, spaceId: string, ids: readonly string[], framesDir?: string): Promise<Switched> {
  if (framesDir !== undefined) {
    const width = await app.evalJS<number>("window.innerWidth");
    const height = await app.evalJS<number>("window.innerHeight");
    await app.captureBurst({ op: "arm", durationMs: FRAMES_MS, intervalMs: FRAMES_INTERVAL_MS, crop: { x: 0, y: 0, width, height }, outDir: framesDir });
  }
  await app.bodyLayers({ op: "arm", windowMs: LAYERS_MS });
  const before = (await app.handOvers()).handOvers;
  const serialBefore = before.length > 0 ? before[before.length - 1].serial : 0;
  await Bun.sleep(50);
  const cutWall = Date.now();
  await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(spaceId)} }), null)`);
  await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id === spaceId, 5_000);
  await allPainted(app, ids);
  const layers = (await settleFor(
    () => app.bodyLayers({ op: "read" }) as Promise<BodyLayersReading>,
    (r) => r.done,
    LAYERS_MS + 5_000,
  )) as BodyLayersReading;
  const frames =
    framesDir === undefined
      ? null
      : ((await settleFor(() => app.captureBurst({ op: "read" }) as Promise<CaptureBurstReading>, (r) => r.done, FRAMES_MS + 10_000)) as CaptureBurstReading);
  const account = await app.handOvers();
  const h = account.handOvers.find((r) => r.serial > serialBefore) ?? null;
  return {
    cutWall,
    rows: layers.rows,
    revealLog: (account.revealLog ?? [])
      .map((line) => line.split(" "))
      .filter(([wall]) => Number(wall) >= cutWall)
      .map(([wall, ...rest]) => `${Number(wall) - cutWall} ms ${rest.join(" ")}`),
    handOver:
      h === null
        ? "none planned"
        : `${h.outcome}, snapshot ${h.snapshotMs === null ? "?" : h.snapshotMs.toFixed(1)} ms, faces ${h.faces.length}, handed over ${h.handedOver.length}`,
    frames,
  };
}

describe.skipIf(!SHOULD_RUN)("at0786 — a workspace switch's skeleton time, and memory at rest", () => {
  test(
    "a cold and a warm switch on a user-shaped deck, and the resident total before and after every workspace has pages",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath);
      tugbankWrite(tugbankPath, "dev.tugapp.deck.layout", "layout", "json", JSON.stringify(LAYOUT));
      const framesDir = process.env.AT0786_FRAMES_DIR ?? join(tmpdir(), "at0786-cold-switch-frames");
      const aheadDir = process.env.AT0786_AHEAD_FRAMES_DIR ?? join(tmpdir(), "at0786-made-ahead-switch-frames");
      mkdirSync(framesDir, { recursive: true });
      mkdirSync(aheadDir, { recursive: true });
      const app = await launchTugApp({
        testName: "at0786-workspace-skeleton-reading",
        env: { TUGBANK_PATH: tugbankPath },
        persistInTestMode: true,
        restoreInTestMode: true,
      });
      try {
        note(`deck: ${SPACES.length} workspaces; each away workspace ${cardsOf(AWAY).length} cards (${AWAY.rail.length} rail + ${AWAY.content.length} content), home ${cardsOf(HOME).length}`);

        expect(await allPainted(app, cardsOf(HOME), 60_000), "the home workspace painted").toBe(true);

        // ---- Cold switch ----
        const madeBefore = (await Promise.all(cardsOf(AWAY).map((id) => bodyOf(app, id)))).filter((b) => b !== null).length;
        note(`cold switch: ${madeBefore}/${cardsOf(AWAY).length} of its cards had a page before the cut`);
        const cold = await readSwitchTo(app, AWAY.id, cardsOf(AWAY), framesDir);
        const coldVisible = firstVisible(cold.rows, cardsOf(AWAY), cold.cutWall);
        const coldStart = Object.fromEntries(cardsOf(AWAY).map((id) => [id, cold.rows.find((r) => r.cardId === id && r.wall >= cold.cutWall)?.start ?? "?"]));
        note(`cold switch: hand-over ${cold.handOver}`);
        note(`cold switch: reveal set ${cold.revealLog.join("; ") || "did nothing"}`);
        note(`cold switch per card (first shown page / start): ${cardsOf(AWAY).map((id) => `${id} ${ms(coldVisible[id])} / ${coldStart[id]}`).join("; ")}`);
        const visibles = Object.values(coldVisible).filter((v): v is number => v !== null);
        note(
          `cold switch summary: first shown ${ms(visibles.length > 0 ? Math.min(...visibles) : null)}, last ${ms(visibles.length > 0 ? Math.max(...visibles) : null)}, ` +
            `median ${ms(median(visibles))}; ${cold.frames?.frames.length ?? 0} frames kept in ${framesDir}, ` +
            `the cut at frame ${cold.frames?.frames.findIndex((f) => f.wall >= cold.cutWall) ?? "?"}`,
        );
        expect(Object.values(coldVisible).every((v) => v !== null), "every page of the cold switch painted and showed").toBe(true);

        // ---- Made-ahead switch ----
        await readSwitchTo(app, HOME.id, cardsOf(HOME));
        await Bun.sleep(REST_MS);
        const one = memory();
        note(`memory, made ahead: ${one.count} WebContent processes, ${mb(one.kb)} MB`);
        const ahead = (await Promise.all(cardsOf(THIRD).map((id) => bodyOf(app, id)))).filter((b) => b?.painted === true).length;
        note(`made-ahead switch: ${ahead}/${cardsOf(THIRD).length} of its cards painted before the cut`);
        const made = await readSwitchTo(app, THIRD.id, cardsOf(THIRD), aheadDir);
        const mv = Object.values(firstVisible(made.rows, cardsOf(THIRD), made.cutWall)).filter((x): x is number => x !== null);
        note(`made-ahead switch: hand-over ${made.handOver}; reveal set ${made.revealLog.join("; ") || "did nothing"}`);
        const holds = ((await app.handOvers()) as unknown as { switchHolds?: { cards: string[]; heldMs: number | null; outcome: string }[] }).switchHolds ?? [];
        const hold = holds.at(-1);
        note(`made-ahead switch: the host's held picture ${hold === undefined ? "never stood" : `${hold.outcome}, held ${hold.heldMs === null ? "?" : Math.round(hold.heldMs)} ms over ${hold.cards.length} cards`}`);
        const torn = await tornFrames(app, made, [...THIRD.rail, ...THIRD.content.filter((c) => c.kind === "text").map((c) => c.id)]);
        note(`made-ahead switch: frames that are neither workspace — ${torn.length === 0 ? "none" : torn.join("; ")}`);
        note(
          `made-ahead switch summary: last shown ${ms(mv.length > 0 ? Math.max(...mv) : null)}, ${mv.length}/${cardsOf(THIRD).length} shown; ` +
            `${made.frames?.frames.length ?? 0} frames kept in ${aheadDir}, the cut at frame ${made.frames?.frames.findIndex((f) => f.wall >= made.cutWall) ?? "?"}`,
        );
        expect(mv.length, "every page of the made-ahead switch showed").toBe(cardsOf(THIRD).length);

        // ---- Warm switch ----
        await readSwitchTo(app, HOME.id, cardsOf(HOME));
        await Bun.sleep(1_000);
        const warm = await readSwitchTo(app, AWAY.id, cardsOf(AWAY));
        const warmVisible = firstVisible(warm.rows, cardsOf(AWAY), warm.cutWall);
        const wv = Object.values(warmVisible).filter((v): v is number => v !== null);
        note(`warm switch: hand-over ${warm.handOver}; reveal set ${warm.revealLog.join("; ") || "did nothing"}`);
        note(`warm switch summary: slowest ${ms(wv.length > 0 ? Math.max(...wv) : null)}, median ${ms(median(wv))}, ${wv.length}/${cardsOf(AWAY).length} shown`);

        // ---- Memory, every workspace ----
        for (const s of [FOURTH]) {
          const visit = await readSwitchTo(app, s.id, cardsOf(s));
          const v = Object.values(firstVisible(visit.rows, cardsOf(s), visit.cutWall)).filter((x): x is number => x !== null);
          note(`visit ${s.id}: last shown ${ms(v.length > 0 ? Math.max(...v) : null)}, ${v.length}/${cardsOf(s).length} shown; hand-over ${visit.handOver}; reveal set ${visit.revealLog.join("; ") || "did nothing"}`);
        }
        await readSwitchTo(app, HOME.id, cardsOf(HOME));
        await Bun.sleep(REST_MS);
        const all = memory();
        const pages = SPACES.reduce((n, s) => n + cardsOf(s).length, 0);
        note(
          `memory, every workspace made: ${all.count} WebContent processes, ${mb(all.kb)} MB; ` +
            `growth ${mb(all.kb - one.kb)} MB over ${all.count - one.count} more processes, ${mb((all.kb - one.kb) / Math.max(1, all.count - one.count))} MB each; ` +
            `${pages} card pages in the deck`,
        );
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

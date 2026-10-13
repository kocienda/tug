/**
 * at0727-population-ceiling-reading.test.ts — the deck read fresh, aged, and
 * read again: what WebKit walks once the deck has a history.
 *
 * What is left on the main thread after the stream path came off it is the
 * engine's own cost of the document — the compositing walk, style and
 * layout — and that cost is priced by what is mounted. What is mounted grows
 * with use: the Overview fills toward its 150 posts, transcripts stream and
 * are swept, and a width change can mount a whole transcript to re-measure it.
 * A deck at launch and the same deck after a working day are not the same
 * deck, and every reading before this one was taken on the first.
 *
 * So this file stands one deck up and reads it twice with the instruments the
 * user's deck is read with (`tugtool deck motion layers` and `walk`):
 *
 *  - **The deck.** Four session cards four-up and an Overview in a rail. `c1`
 *    resumes a real transcript (the slice, or the whale where the corpus has
 *    one); `c2`–`c4` bind to stubbed sessions that stream one turn each
 *    (`streaming-stub-fixture.ts`).
 *  - **Fresh.** Thirty Overview posts, so the column's viewport is full before
 *    anything ages — the fresh and aged decks differ by history, not by
 *    whether the Overview has content. Then the census and the walk.
 *  - **Aged.** A hundred and twenty more posts (150, the store's cap), three
 *    streamed turns run to their end, every transcript and the Overview swept
 *    top to bottom, and two reflowing settles driven (a fold and a column
 *    split) with an in-page sampler recording the peak mounted rows. Then the
 *    deck is returned to its live edges and read again.
 *
 * Every number is noted — the paired readings, the full-mount peaks, and each
 * drive's sealed clause — and three are the ceiling, asserted:
 *
 *  - the aged Overview mounts fewer cells than the posts it holds;
 *  - no reflowing settle mounts a whole transcript that evicts at rest;
 *  - every reflowing settle is sealed: nothing commits, forces layout or
 *    delivers an observer callback between its first frame and its land.
 *
 * Every drive starts from a deck at rest by the verb's own budget: the test
 * waits for `deck motion rest` to read at or under the probe's
 * `restBudgetPerSecond`, fails naming what `deck motion list` says runs when
 * it never does, and drives with the verb's own refusal of a busy deck
 * standing behind the wait. A reading over a busy deck is not the gesture's.
 *
 * The verb is the bundle's own `tugtool`, built from this tree with the app.
 *
 * The aged deck's mean baseline walk against the fresh one's plus
 * `CEILING_MARGIN_MS` is noted, not asserted. Code that mounted whole
 * transcripts passed it, and code that never does read past it once its
 * fresh walk alone got faster, so it does not tell the two apart.
 *
 * @motion
 * @covers tugdeck/src/components/tugways/internal/list-view-window.ts
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/overview/use-overview-window.ts
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_walk.js
 * @covers tests/app-test/streaming-stub-fixture.ts
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

import { note, type App } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { DEFAULT_OVERVIEW_WIDTH_PX } from "../../tugdeck/src/lib/overview-measure";
import { sealedClause } from "../../tugdeck/src/lib/motion-guard/settle-bar";
import {
  AFTER_LAND_MS,
  SHOULD_RUN,
  SPACE_ID,
  flowDeck,
  launch,
  expectMotionSealed,
  settleBeatRows,
  settleFrameRows,
  transcriptArms,
} from "./settle-frames-fixture";
import {
  STUB_TRANSCRIPT_DIR_ENV,
  bindStreamingStubs,
  startStreams,
  stubDirectory,
} from "./streaming-stub-fixture";

const TEST_NAME = "at0727-population-ceiling-reading";
const ARMS = transcriptArms();

/** The resumed card, and the three that stream. */
const SUBJECT = "at0622-c1";
const STREAMERS = ["at0622-c2", "at0622-c3", "at0622-c4"] as const;
/** The streamer sized past the window's reach (S01 step 1). */
const LONG_STREAMER = "at0622-c2";

/**
 * Each stub streams `STREAM_TURNS` turns of `STREAM_MESSAGES` messages. A
 * turn is one transcript row, so the turn count is what puts rows beyond the
 * window's reach: one turn of many messages is a single row eight viewports
 * tall, which nothing can evict. Eight turns of two messages make sixteen
 * rows of about three viewports each, streamed in about a minute.
 */
const STREAM_MESSAGES = 2;
const STREAM_TURNS = 8;

/** How long one round of three turns may take to end. */
const TURNS_END_MS = 60_000;

/** Overview posts before the fresh reading, and after aging (the store's cap). */
const FRESH_POSTS = 30;
const AGED_POSTS = 150;

/**
 * A transcript qualifies for the peak comparison past this many viewports,
 * and only while it evicts at rest (fewer rows mounted than it has): a peak
 * can be told from the window only on a transcript the window does not hold.
 */
const QUALIFYING_VIEWPORTS = 6;

/** Walk rounds and frames per burst, the same for both readings. */
const WALK_ROUNDS = 5;
const WALK_FRAMES = 30;

/**
 * The ceiling margin, `max(spread, 0.5 ms)` over the fresh harness reading's
 * paired-baseline mean walks: the instrument's own noise is the smallest
 * margin that is not noise, and the floor keeps a quiet fresh reading from
 * setting a bar no run can meet. The aged reading is held to it.
 *
 * Fresh harness reading, 2026-10-12, at `9714b6f37` (slice arm): the
 * baseline's mean spread was 1.33 ms (an earlier run of the same reading read
 * 1.10), above the floor.
 */
const CEILING_MARGIN_MS = 1.33;

/** Floor under the margin, so a quiet fresh reading cannot set an unmeetable bar. */
const MARGIN_FLOOR_MS = 0.5;

/**
 * One arm stands up a deck, reads it, ages it, and reads it again. Named
 * `TEST_TIMEOUT_MS` because the recipe's wedge cap reads that declaration.
 */
const TEST_TIMEOUT_MS = 1_200_000;

/** No one verb runs longer than this; a verb that does is killed and reads as a failed exit. */
const VERB_TIMEOUT_MS = 240_000;
/** How long a drive waits for the deck to read at rest before it fails. */
const REST_WAIT_MS = 30_000;

/** When the file started, for the progress lines. */
const STARTED = performance.now();

/**
 * One progress line on stderr. Notes reach the report only when the file
 * ends, so a file stopped at its cap reports nothing of where it was; these
 * lines are what `TUG_APPTEST_STREAM=1` shows while it runs.
 */
function phase(what: string): void {
  console.error(`[at0727 +${Math.round((performance.now() - STARTED) / 1000)}s] ${what}`);
}

const SCROLLERS = '[data-tug-scroll-key="session-card-transcript"]';
const OVERVIEW_COLUMN = '[data-testid="overview-card"] .overview-transcript';

/** This checkout, and its HEAD — a path and a sha the annotator resolves. */
const REPO_ROOT = resolve(import.meta.dir, "../..");
const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();

/** Four session cards four-up, a Layout rail on the right and an Overview on the left. */
function agingBlob(): Record<string, unknown> {
  const deck = flowDeck(4);
  const cards = deck.cards as Record<string, unknown>[];
  const panes = deck.panes as Record<string, unknown>[];
  const imposition = deck.imposition as Record<string, unknown>;
  return {
    version: 5,
    activeSpaceId: SPACE_ID,
    spaces: [
      {
        id: SPACE_ID,
        name: "One",
        deck: {
          ...deck,
          cards: [...cards, { id: "at0727-o1", componentId: "overview", title: "Overview", closable: true }],
          panes: [
            ...panes,
            {
              id: "at0727-po1",
              position: { x: 0, y: 0 },
              size: { width: DEFAULT_OVERVIEW_WIDTH_PX, height: 900 },
              cardIds: ["at0727-o1"],
              activeCardId: "at0727-o1",
              title: "Overview",
              acceptsFamilies: [] as string[],
            },
          ],
          imposition: {
            ...imposition,
            sidebars: { layout: { side: "right" }, overview: { side: "left" } },
          },
        },
      },
    ],
  };
}

/** The bundle's own `tugtool`, beside the app binary the harness launched. */
function tugtoolPath(): string {
  const app = process.env.TUGAPP_DEBUG_PATH;
  if (app === undefined || app === "") {
    throw new Error("TUGAPP_DEBUG_PATH is unset; run this file through `just app-test`");
  }
  return join(dirname(app), "tugtool");
}

/** The port this instance's tugcast serves the page from. */
async function portOf(app: App): Promise<string> {
  const port = await app.evalJS<string>("location.port");
  if (!/^\d+$/.test(port)) throw new Error(`the page reports no tugcast port: '${port}'`);
  return port;
}

/** Run `tugtool deck motion …` against this instance and parse its envelope. */
function deckMotion(port: string, args: string[]): { exit: number; json: Record<string, unknown> | null; stderr: string } {
  const t0 = performance.now();
  const run = Bun.spawnSync([tugtoolPath(), "deck", "motion", ...args, "--port", port, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: VERB_TIMEOUT_MS,
  });
  phase(`deck motion ${args[0]} exited ${run.exitCode} after ${Math.round(performance.now() - t0)} ms`);
  const stdout = run.stdout.toString();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { exit: run.exitCode ?? -1, json, stderr: run.stderr.toString() };
}

/**
 * Publish posts `[from, to)`: multi-paragraph bodies naming a path and a sha.
 * One `evalJS` per post, as at0365 does: thirty posts in one script never got
 * the harness's reply, and the eval's own timeout never fired.
 */
async function publishPosts(app: App, from: number, to: number): Promise<void> {
  let accepted = 0;
  for (let i = from; i < to; i += 1) {
    const post = JSON.stringify({
        id: 10_000 + i,
        at_ms: 1_754_600_000_000 + i * 60_000,
        author: i % 2 === 0 ? "observer" : "operator",
        body:
          `Post ${i + 1}: the reader went through tugdeck/src/components/tugways/tug-list-view.tsx ` +
          `and the eviction branch it carries, and found the window holding at ${HEAD_SHA.slice(0, 9)}.\n\n` +
          "Nothing outside the scrollport was mounted while the reader stayed at the live edge, " +
          "and the spacers above and below the window summed to the ledger's heights.\n\n" +
          `The next pass reads tugdeck/src/components/overview/overview-card.tsx the same way.`,
        refs: [],
        project_dir: REPO_ROOT,
    });
    if (await app.evalJS<boolean>(`window.__tug.publishOverviewPost(${JSON.stringify(post)})`)) accepted += 1;
  }
  expect(accepted, `posts ${from}–${to} accepted`).toBe(to - from);
}

/** How many posts the Overview holds — the store's count. The column is
 *  windowed, so its mounted cells are the posts near the scrollport, not all
 *  it holds; the census beside the walk reads the mounted ones. */
const overviewPostsHeld = (app: App): Promise<number> =>
  app.evalJS<number>(`(window.__tug.overviewPosts() || []).length`);

/** Every transcript scroller and the Overview column back at their live edges. */
async function toLiveEdges(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var els = Array.from(document.querySelectorAll(${JSON.stringify(SCROLLERS)}));
      var col = document.querySelector(${JSON.stringify(OVERVIEW_COLUMN)});
      if (col) els.push(col);
      els.forEach(function (el) { el.scrollTop = el.scrollHeight; });
      return null;
    })()`,
  );
  await Bun.sleep(AFTER_LAND_MS);
}

interface TranscriptRest {
  readonly card: string | null;
  readonly mounted: number;
  readonly rows: number;
  readonly fallbacks: number;
  readonly viewports: number;
  readonly qualifies: boolean;
}

/**
 * Each transcript at rest: its mounted cells, its row count (one past the
 * largest index mounted while it rests at the bottom), its eviction fallbacks,
 * and how many of its viewports its content spans.
 */
const transcriptsAtRest = (app: App): Promise<TranscriptRest[]> =>
  app.evalJS<TranscriptRest[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(SCROLLERS)})).map(function (el) {
      var card = el.closest("[data-card-id]");
      var max = -1;
      el.querySelectorAll("[data-tug-list-cell-index]").forEach(function (c) {
        var i = Number(c.getAttribute("data-tug-list-cell-index"));
        if (i > max) max = i;
      });
      var viewports = el.clientHeight > 0 ? el.scrollHeight / el.clientHeight : 0;
      return {
        card: card ? card.getAttribute("data-card-id") : null,
        mounted: el.querySelectorAll(".tug-list-view-cell").length,
        rows: max + 1,
        fallbacks: Number(el.getAttribute("data-evict-fallbacks") || "0"),
        viewports: Math.round(viewports * 10) / 10,
        qualifies: viewports > ${QUALIFYING_VIEWPORTS} && el.querySelectorAll(".tug-list-view-cell").length < max + 1,
      };
    })`,
  );

/**
 * Sweep every transcript and the Overview column from top to bottom, one
 * viewport per two frames, in the page. Resolves when the page says it is done.
 */
async function sweep(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var els = Array.from(document.querySelectorAll(${JSON.stringify(SCROLLERS)}));
      var col = document.querySelector(${JSON.stringify(OVERVIEW_COLUMN)});
      if (col) els.push(col);
      window.__at0727Sweep = { done: false, steps: 0 };
      var frame = function () { return new Promise(function (r) { requestAnimationFrame(function () { r(null); }); }); };
      (async function () {
        for (var k = 0; k < els.length; k += 1) {
          var el = els[k];
          el.scrollTop = 0;
          await frame(); await frame();
          while (el.scrollTop + el.clientHeight < el.scrollHeight - 1) {
            el.scrollTop = el.scrollTop + el.clientHeight;
            window.__at0727Sweep.steps += 1;
            await frame(); await frame();
          }
        }
        window.__at0727Sweep.done = true;
      })();
      return null;
    })()`,
  );
  await app.waitForCondition<boolean>(`window.__at0727Sweep && window.__at0727Sweep.done === true`, {
    timeoutMs: 180_000,
  });
  note(`at0727 sweep: ${await app.evalJS<number>("window.__at0727Sweep.steps")} step(s)`);
}

/** Arm the in-page peak sampler: per transcript, and the Overview, every frame. */
const armPeaks = (app: App): Promise<null> =>
  app.evalJS<null>(
    `(function () {
      var peaks = { transcripts: {}, overview: 0, batches: 0, live: true };
      window.__at0727Peaks = peaks;
      // Counted on every DOM change rather than every frame: a row mounts by
      // insertion, so no peak is missed, and a deck where nothing changes runs
      // nothing — a per-frame loop here was itself what the settle verb's
      // at-rest window read as a busy deck.
      var count = function () {
        if (!peaks.live) return;
        peaks.batches += 1;
        document.querySelectorAll(${JSON.stringify(SCROLLERS)}).forEach(function (el) {
          var card = el.closest("[data-card-id]");
          var id = card ? card.getAttribute("data-card-id") : "?";
          var n = el.querySelectorAll(".tug-list-view-cell").length;
          if (!(id in peaks.transcripts) || n > peaks.transcripts[id]) peaks.transcripts[id] = n;
        });
        var col = document.querySelector(${JSON.stringify(OVERVIEW_COLUMN)});
        if (col) {
          var o = col.querySelectorAll(":scope > .overview-cell").length;
          if (o > peaks.overview) peaks.overview = o;
        }
      };
      peaks.observer = new MutationObserver(count);
      peaks.observer.observe(document.body, { childList: true, subtree: true });
      count();
      return null;
    })()`,
  );

interface Peaks {
  readonly transcripts: Record<string, number>;
  readonly overview: number;
  /** The DOM-change batches the sampler counted through. */
  readonly batches: number;
}

const readPeaks = (app: App): Promise<Peaks> =>
  app.evalJS<Peaks>(
    `(function () { var p = window.__at0727Peaks; p.live = false; p.observer.disconnect(); return { transcripts: p.transcripts, overview: p.overview, batches: p.batches }; })()`,
  );

interface Reading {
  readonly label: string;
  readonly meanMedian: number;
  readonly meanSpread: number;
  /** Overview cells mounted, by the walk's census. */
  readonly overviewCells: number;
}

/**
 * One reading: `layers`, then `walk` with the Overview and transcript arms,
 * then every transcript at rest. One note per instrument, the same fields for
 * fresh and aged so the two sit side by side.
 */
async function read(app: App, port: string, label: string): Promise<Reading> {
  const layers = deckMotion(port, ["layers"]);
  expect(layers.exit, `${label} layers: ${layers.stderr}`).toBe(0);
  note(`at0727 ${label} layers: ${JSON.stringify(layers.json?.data ?? null)}`);

  const walk = deckMotion(port, [
    "walk",
    "--rounds",
    String(WALK_ROUNDS),
    "--frames",
    String(WALK_FRAMES),
    "--arms",
    "overview-absent,transcript-absent",
  ]);
  expect(walk.exit, `${label} walk exited ${walk.exit}: ${walk.stderr} ${JSON.stringify(walk.json)}`).toBe(0);
  const data = (walk.json?.data ?? null) as {
    census?: { document?: unknown; subjects?: { overview?: Record<string, unknown>; transcript?: Record<string, unknown> } };
    baseline?: { median: number; spread: number; meanMedian: number; meanSpread: number };
    arms?: { arm: string; byMean?: unknown; priceByMean?: unknown; subjects?: number }[];
    rounds?: number;
  } | null;
  expect(data?.census, `${label}: the walk carries a census`).toBeTruthy();
  expect(data?.rounds, `${label}: five baseline rounds`).toBe(WALK_ROUNDS);
  const overview = data!.census!.subjects?.overview ?? {};
  note(
    `at0727 ${label} census: document ${JSON.stringify(data!.census!.document)}, ` +
      `overview cells ${String(overview.cells)} population ${JSON.stringify(overview.population)}, ` +
      `stacking ${JSON.stringify(overview.stackingHistogram)}, sticky ${JSON.stringify(overview.stickyHistogram)}, ` +
      `transcript ${JSON.stringify(data!.census!.subjects?.transcript ?? null)}`,
  );
  note(`at0727 ${label} walk baseline: ${JSON.stringify(data!.baseline)}`);
  for (const arm of data!.arms ?? []) {
    note(
      `at0727 ${label} walk ${arm.arm}: subjects ${arm.subjects}, by mean ${JSON.stringify(arm.byMean)}, ` +
        `price by mean ${JSON.stringify(arm.priceByMean)}`,
    );
  }
  note(`at0727 ${label} transcripts: ${JSON.stringify(await transcriptsAtRest(app))}`);
  return {
    label,
    meanMedian: data!.baseline!.meanMedian,
    meanSpread: data!.baseline!.meanSpread,
    overviewCells: Number(overview.cells),
  };
}

/**
 * Wait until the deck reads at rest by the verb's own budget — the probe's
 * `restBudgetPerSecond`, the value `settle` refuses a busy deck against — and
 * note the reading. Bounded: a deck that never rests fails here, naming what
 * `deck motion list` says is running, rather than driving over it.
 */
async function awaitRest(port: string, name: string): Promise<void> {
  const probe = deckMotion(port, ["probe"]);
  const budget = (probe.json?.data as { restBudgetPerSecond?: unknown } | undefined)?.restBudgetPerSecond;
  if (typeof budget !== "number") {
    throw new Error(`${name}: the probe reports no rest budget: ${probe.stderr} ${JSON.stringify(probe.json)}`);
  }
  const deadline = performance.now() + REST_WAIT_MS;
  let last: unknown = null;
  for (;;) {
    const rest = deckMotion(port, ["rest"]);
    const reading = rest.json?.data as { updatesPerSecond?: unknown } | undefined;
    last = reading ?? rest.stderr;
    if (typeof reading?.updatesPerSecond === "number" && reading.updatesPerSecond <= budget) {
      note(`at0727 ${name} at rest before the drive (budget ${budget}/s): ${JSON.stringify(reading)}`);
      return;
    }
    if (performance.now() > deadline) {
      const running = deckMotion(port, ["list"]);
      throw new Error(
        `${name}: the deck never read at rest within ${REST_WAIT_MS / 1_000} s ` +
          `(budget ${budget}/s, last ${JSON.stringify(last)}); running: ` +
          JSON.stringify(running.json?.data ?? running.stderr).slice(0, 4_000),
      );
    }
  }
}

/**
 * Drive one reflowing gesture twice through the verb, from a deck at rest,
 * with the peak sampler armed from the drive to the land plus a second, and
 * hold each settle to the sealed clause over the `settle-frames` rows written
 * since the mark. Fold and split carry no carve-out.
 */
async function drive(app: App, port: string, name: string, flags: string[]): Promise<Peaks> {
  await awaitRest(port, name);
  // The trace's own sequence mark: an aged deck has filled the trace's ring,
  // so its length is no longer a position in it.
  const mark = await app.evalJS<number>("window.__deckTrace.mark()");
  await armPeaks(app);
  // A default drive: the verb refuses a busy deck, which the wait above
  // has already ruled out.
  const run = deckMotion(port, ["settle", ...flags, "--count", "2"]);
  await Bun.sleep(1_000);
  const peaks = await readPeaks(app);
  expect(run.exit, `settle ${name} exited ${run.exit}: ${run.stderr} ${JSON.stringify(run.json)}`).toBe(0);
  const readings = ((run.json?.data as { readings?: unknown[] } | undefined)?.readings ?? []) as unknown[];
  expect(readings.length, `${name}: both drives read`).toBe(2);
  note(`at0727 ${name} floor: ${JSON.stringify((run.json?.data as { rest?: unknown } | undefined)?.rest ?? null)}`);
  const rows = await settleFrameRows(app, mark);
  rows.forEach((row, i) => {
    const sealed = sealedClause(row);
    note(
      `at0727 ${name} settle ${i + 1}/${rows.length} (${row.kind}, ${row.panes} pane(s)): ` +
        `sealed ${sealed.pass} — ${sealed.detail}`,
    );
  });
  note(`at0727 ${name} peaks: ${JSON.stringify(peaks)}`);
  expect(rows.length, `${name}: the settles wrote their rows`).toBeGreaterThan(0);
  // The motion gate closes behind a settle's beats, so a settle that launched
  // none — the slot-0 split on this deck launches no beat and moves nothing —
  // has no motion to seal, and its clause reads that the gate never closed.
  // That reading is accepted only when the drive launched no beat at all; a
  // beat that ran without the gate closing behind it is a leak, and fails.
  const beats = await settleBeatRows(app, mark);
  note(`at0727 ${name} beats: ${JSON.stringify(beats.map((b) => [b.recipe, b.landing]))}`);
  rows.forEach((row, i) => {
    if (beats.length === 0 && (row.motionAtMs ?? -1) < 0) {
      note(`at0727 ${name} settle ${i + 1}: no beat launched, nothing moved, nothing to seal`);
      return;
    }
    expectMotionSealed(`${name} settle ${i + 1}`, row);
  });
  await Bun.sleep(AFTER_LAND_MS);
  return peaks;
}

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0727 — the deck read fresh and aged [${arm.size}]`,
  () => {
    test(
      "a fresh reading, an aging, and an aged reading, end to end",
      async () => {
        const stubDir = stubDirectory();
        const { app, tugbankPath } = await launch(4, agingBlob(), TEST_NAME, {
          transcripts: arm.size,
          whaleCards: [SUBJECT],
          resumeCards: [SUBJECT],
          env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
        });
        try {
          phase("launched; binding the stubs");
          const stubs = await bindStreamingStubs(app, STREAMERS, stubDir, STREAM_MESSAGES, STREAM_TURNS);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERVIEW_COLUMN)}) !== null`,
            { timeoutMs: 15_000 },
          );

          // ── Fresh ──────────────────────────────────────────────────────────
          phase("publishing the fresh posts");
          await publishPosts(app, 0, FRESH_POSTS);
          await toLiveEdges(app);
          await Bun.sleep(AFTER_LAND_MS);

          const port = await portOf(app);
          const enable = deckMotion(port, ["enable"]);
          expect(enable.exit, `deck motion enable: ${enable.stderr}`).toBe(0);

          phase("fresh reading");
          const fresh = await read(app, port, `[${arm.size}] fresh`);

          // ── Age ────────────────────────────────────────────────────────────
          // (a) The Overview to its cap.
          phase("aging: publishing to the cap");
          await publishPosts(app, FRESH_POSTS, AGED_POSTS);
          await app.waitForCondition<boolean>(
            `(window.__tug.overviewPosts() || []).length >= ${AGED_POSTS}`,
            { timeoutMs: 30_000 },
          );
          expect(await overviewPostsHeld(app), "150 Overview posts held").toBe(AGED_POSTS);

          // (b) Three sessions stream every turn of their transcripts, each
          // round of three run to its end before the next prompt.
          phase("aging: streaming three sessions");
          for (let turn = 0; turn < STREAM_TURNS; turn += 1) {
            await startStreams(app, stubs);
            for (const { cardId } of stubs) {
              await app.waitForCondition<boolean>(
                `(function(){
                  var entry = document.querySelector('[data-card-id="${cardId}"] [data-slot="tug-prompt-entry"]');
                  return entry !== null && entry.getAttribute("data-phase") === "idle";
                })()`,
                { timeoutMs: TURNS_END_MS },
              );
            }
          }
          note(`at0727 [${arm.size}] three streams completed, ${STREAM_TURNS} turn(s) each`);
          await Bun.sleep(AFTER_LAND_MS);

          // S01 step 1's precondition: one transcript is beyond the window's
          // reach whichever arm `c1` runs.
          const streamed = await transcriptsAtRest(app);
          const long = streamed.find((t) => t.card === LONG_STREAMER);
          expect(
            long?.qualifies,
            `${LONG_STREAMER} spans more than ${QUALIFYING_VIEWPORTS} viewports and evicts at rest: ${JSON.stringify(long)}`,
          ).toBe(true);

          // (c) Sweep every scroller top to bottom.
          phase("aging: sweeping");
          await sweep(app);
          await toLiveEdges(app);

          // (d) Two reflowing settles, with the peaks sampled.
          phase("aging: reflowing settles");
          // The deck writes its `settle-frames` rows only while motion
          // recording is on, and they are what the sealed clause reads.
          const record = deckMotion(port, ["record", "on"]);
          expect(record.exit, `deck motion record on: ${record.stderr}`).toBe(0);
          const foldPeaks = await drive(app, port, `[${arm.size}] fold`, ["--gesture", "fold", "--card", SUBJECT]);
          const splitPeaks = await drive(app, port, `[${arm.size}] split`, ["--gesture", "split", "--slot", "0"]);

          // (e) Back to the live edges, and at rest.
          await toLiveEdges(app);
          await Bun.sleep(AFTER_LAND_MS);

          const rest = await transcriptsAtRest(app);
          for (const t of rest.filter((r) => r.qualifies)) {
            note(
              `at0727 [${arm.size}] full-mount peak ${t.card}: ${t.rows} row(s), fold peak ` +
                `${foldPeaks.transcripts[t.card ?? "?"] ?? "—"}, split peak ${splitPeaks.transcripts[t.card ?? "?"] ?? "—"}, ` +
                `at rest ${t.mounted} mounted, ${t.fallbacks} fallback(s)`,
            );
          }
          expect(rest.filter((r) => r.qualifies).length, "at least one transcript qualifies").toBeGreaterThan(0);
          // No reflowing settle mounts a whole transcript that evicts at rest.
          for (const t of rest.filter((r) => r.qualifies)) {
            for (const [gesture, peaks] of [["fold", foldPeaks], ["split", splitPeaks]] as const) {
              const peak = peaks.transcripts[t.card ?? "?"];
              expect(peak, `${t.card}: sampled through the ${gesture}`).toBeDefined();
              expect(peak!, `${t.card}: the ${gesture} mounted fewer than its ${t.rows} rows`).toBeLessThan(t.rows);
            }
          }
          note(
            `at0727 [${arm.size}] Overview peak: fold ${foldPeaks.overview}, split ${splitPeaks.overview} ` +
              `of ${AGED_POSTS} posts`,
          );

          // ── Aged ───────────────────────────────────────────────────────────
          phase("aged reading");
          const aged = await read(app, port, `[${arm.size}] aged`);

          // The margin this reading would set, noted beside the one it is held to.
          const margin = Math.max(fresh.meanSpread, MARGIN_FLOOR_MS);
          note(
            `at0727 [${arm.size}] ceiling: fresh mean walk ${fresh.meanMedian.toFixed(2)} ms ` +
              `(spread ${fresh.meanSpread.toFixed(2)}), aged ${aged.meanMedian.toFixed(2)} ms ` +
              `(spread ${aged.meanSpread.toFixed(2)}); margin from this reading ${margin.toFixed(2)} ms, ` +
              `CEILING_MARGIN_MS ${CEILING_MARGIN_MS}; aged − fresh ${(aged.meanMedian - fresh.meanMedian).toFixed(2)} ms`,
          );
          note(`at0727 [${arm.size}] Overview cells: fresh ${fresh.overviewCells}, aged ${aged.overviewCells} of ${AGED_POSTS}`);

          // The ceiling. The walk against the margin is a reading, not a bar.
          note(
            `at0727 [${arm.size}] aged walk ${aged.meanMedian <= fresh.meanMedian + CEILING_MARGIN_MS ? "within" : "past"} ` +
              `the fresh walk plus CEILING_MARGIN_MS`,
          );
          expect(aged.overviewCells, "the aged Overview mounts fewer cells than it holds posts").toBeLessThan(AGED_POSTS);

          deckMotion(port, ["disable"]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

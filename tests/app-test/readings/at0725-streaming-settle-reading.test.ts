/**
 * at0725-streaming-settle-reading.test.ts — the settle reading, taken with
 * three sessions streaming.
 *
 * Every settle reading before this one was taken on a deck where nothing
 * streamed, and the judder users report happens with three or four sessions
 * streaming. This file stands up that condition on a controlled deck and
 * reads it with the verb the user's deck is read with, so the two readings
 * are one instrument's:
 *
 *  - Four session cards, four-up. `c1` resumes a real transcript — the slice,
 *    or on the whale arm the corpus's whale — and is the card the gestures
 *    move. `c2`–`c4` bind to stubbed sessions (`streaming-stub-fixture.ts`)
 *    whose tugcode replays one long turn at a token cadence through
 *    tugcast's real feed, and each is sent a prompt so all three stream.
 *  - Each gesture — a fold and a slot move, the folding and the switching of
 *    columns the report names — is driven twice under `--streaming 3`, which
 *    refuses to read unless three sessions are mid-turn before every drive.
 *    First with `--quiet-instruments` and nothing else: no lead recorder, no
 *    native sampler, no commit census, no heartbeat or observer of the
 *    verb's own. That drive is the reading of record. Then again with
 *    `--tasks --sample`, for attribution only, and every reading taken that
 *    way is labelled instrumented, because each of those instruments costs
 *    frames inside the window it reads.
 *  - `tugtool deck motion gaps` is read around the quiet drives, and its
 *    rows inside them are the gap reading of record: the late frames the
 *    always-recorded `settle-gap` row kept, each with the beat at both ends
 *    of its gap, so a set-up's cost sums under the lead and only a judder
 *    inside a beat counts against the one-period bar. The rows the
 *    instrumented drives add are noted beside them, labelled.
 *  - Inside every streaming drive's motion — between its gate's close and
 *    its open — the page applied no ingest batch: the wire is held in the
 *    ingest Worker while the gate is closed, and a batch already in flight
 *    waits on the page for the open.
 *
 * What it asserts is that the arm runs end to end: every reading taken, each
 * under three streams, the quiet drive's gap rows classed by both beats, the
 * instrumented drive's samplers' phases beside them, the wire sealed inside
 * every motion, and no row of a turn in flight parsed at rest: the streamed
 * rows draw from tugcast's renders. The numbers are noted, not barred — this
 * is the baseline the program's fixes are read against, and its record is the
 * program brief's (`briefs/main-thread-headroom-program-brief.md`).
 *
 * The verb is the bundle's own `tugtool`, built from this tree with the app.
 *
 * @motion
 * @covers tests/app-test/streaming-stub-fixture.ts
 * @covers tugcode/src/stub-replay.ts
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_settle.rs
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_settle.js
 * @covers tugdeck/src/lib/settle-gap-sampler.ts
 * @covers tugdeck/src/lib/ingest/session-link.ts
 * @covers tugdeck/src/lib/ingest/session-patch.ts
 * @covers tugdeck/src/lib/ingest/ingest-host.ts
 * @covers tugdeck/src/lib/markdown/parse-counters.ts
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { note, type App } from "../_harness";
import { rmTempTugbank } from "../_harness/tugbank-helpers";
import { AFTER_LAND_MS, SHOULD_RUN, blobFor, launch, transcriptArms } from "../settle-frames-fixture";
import {
  STUB_TRANSCRIPT_DIR_ENV,
  bindStreamingStubs,
  startStreams,
  stubDirectory,
} from "../streaming-stub-fixture";

const TEST_NAME = "at0725-streaming-settle-reading";
const ARMS = transcriptArms();

/** The card the gestures move, and the three that stream. */
const SUBJECT = "at0622-c1";
const STREAMERS = ["at0622-c2", "at0622-c3", "at0622-c4"] as const;

/** Each gesture's reading: its verb flags beyond the shared ones. */
const GESTURES: readonly { name: string; flags: string[] }[] = [
  { name: "fold", flags: ["--gesture", "fold", "--card", SUBJECT] },
  { name: "slot", flags: ["--gesture", "slot", "--card", SUBJECT, "--slot", "2"] },
];

/** Readings per gesture. */
const COUNT = 2;

/** One arm stands up a deck, binds and starts three streams, and reads twice. */
const ARM_TIMEOUT_MS = 900_000;

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
  const run = Bun.spawnSync([tugtoolPath(), "deck", "motion", ...args, "--port", port, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = run.stdout.toString();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { exit: run.exitCode ?? -1, json, stderr: run.stderr.toString() };
}

interface SettleReading {
  readonly window: [number, number] | null;
  readonly lead_ms: number | null;
  readonly longest_gap_ms: number | null;
  readonly commits: unknown[];
  readonly main_thread: { total_ms?: number } | null;
  readonly motion: Record<string, unknown> | null;
  readonly land: Record<string, unknown> | null;
  readonly streams: { inTurn: number; streaming: number } | null;
}

/** The fields of a window commit the largest-commit line reads. */
interface WindowCommitNote {
  readonly react_ms: number | null;
  readonly react_or_span_ms: number;
  readonly performed: number;
  readonly mounted: number;
  readonly top: [string, number][];
  /** Why each pane-chrome component in the commit rendered, as the census names it. */
  readonly why?: string[];
}

interface ThreadPhases {
  readonly thread: string;
  readonly samples: number;
  readonly busy: number;
  /** Busy samples by phase, largest first, as `[phase, samples]`. */
  readonly phases: [string, number][];
}

/** How long the rest census reads React's commits with the streams running, in one-second slices. */
const REST_CENSUS_SLICES = 4;

/** The census keeps its last 400 commits; a slice that reaches it was truncated. */
const CENSUS_CAP = 400;

/**
 * React's time per second at rest, with three sessions streaming: every
 * commit the census walked over `REST_CENSUS_SLICES` seconds, with the lead recorder armed
 * so each commit carries the store read its render began at. A commit's React
 * time is that read to the commit hook — the verb's `react_ms` — and a commit
 * whose render read no store is counted as untimed rather than guessed at. The
 * components are the census's own `top` (performed fibers by name), summed
 * across the window, so the line says whose renders the streams are paying for.
 * The census keeps only its last 400 commits, and three streams commit about
 * 100 times a second, so the window is collected a second at a time and a
 * slice that reaches the cap is reported as capped rather than read short.
 * Over the same window it reads `window.__tugIngest`, the page's always-on
 * count of main-thread tasks carrying wire data, as `ingest` tasks per
 * second with the thread that holds the socket, and the page's markdown row
 * parses per second split by whose row paid them: `liveTurn` for a row of a
 * turn in flight at either end of the window (its identity is
 * `turn.${turnKey}.…`), `other` for everything else (restored rows, static
 * blocks). The live-turn rate is the one a streamed row's parse moves, and
 * it is returned: a row drawn from tugcast's render parses nothing here.
 */
async function noteRestCensus(app: App, label: string): Promise<number | null> {
  const armed = await app.evalJS<boolean>(`(() => {
    if (!window.__tugLead || !window.__tugCommits) return false;
    window.__tugLead.arm();
    window.__at0725Rest = { t0: performance.now(), last: performance.now(), commits: [], capped: 0, ingest0: window.__tugIngest ? window.__tugIngest.tasks : null, parses0: window.__tug.rowParsesByIdentity() };
    return true;
  })()`);
  if (!armed) {
    note(`${label} rest census: no lead recorder or commit census on this page`);
    return null;
  }
  const collect = `(() => {
    const rest = window.__at0725Rest, now = performance.now();
    const slice = window.__tugCommits.since(rest.last).filter((c) => c.t <= now);
    if (slice.length >= ${CENSUS_CAP}) rest.capped += 1;
    for (const c of slice) {
      rest.commits.push({ t: c.t, renderStart: c.renderStart, performed: c.performed, top: c.top, origins: c.origins });
    }
    rest.last = now;
    return slice.length;
  })()`;
  for (let i = 0; i < REST_CENSUS_SLICES; i += 1) {
    await Bun.sleep(1_000);
    await app.evalJS<number>(collect);
  }
  const census = await app.evalJS<string>(`(() => {
    const rest = window.__at0725Rest;
    window.__tugLead.disarm();
    const seen = rest.commits, t0 = rest.t0, t1 = rest.last;
    let reactMs = 0, timed = 0, performed = 0;
    const byName = new Map(), untimedByOrigin = new Map();
    for (const c of seen) {
      if (c.renderStart != null && c.renderStart <= c.t) { reactMs += c.t - c.renderStart; timed += 1; }
      else for (const [name, n] of c.origins || []) untimedByOrigin.set(name, (untimedByOrigin.get(name) || 0) + n);
      performed += c.performed;
      for (const [name, n] of c.top) byName.set(name, (byName.get(name) || 0) + n);
    }
    const secs = (t1 - t0) / 1000;
    const ingest = window.__tugIngest && rest.ingest0 !== null
      ? { host: window.__tugIngest.host, tasksPerSec: Math.round((window.__tugIngest.since(rest.ingest0) / secs) * 10) / 10 }
      : null;
    const parses1 = window.__tug.rowParsesByIdentity(), parses0 = rest.parses0;
    const live = new Set([...parses0.liveTurnKeys, ...parses1.liveTurnKeys].map((k) => "turn." + k + "."));
    let liveParses = 0, otherParses = 0;
    for (const [id, n] of Object.entries(parses1.byIdentity)) {
      const d = n - (parses0.byIdentity[id] || 0);
      if ([...live].some((p) => id.startsWith(p))) liveParses += d; else otherParses += d;
    }
    return JSON.stringify({
      seconds: Math.round(secs * 10) / 10,
      ingest,
      rowParsesPerSec: { liveTurn: Math.round((liveParses / secs) * 10) / 10, other: Math.round((otherParses / secs) * 10) / 10, liveTurns: live.size },
      cappedSlices: rest.capped,
      commitsPerSec: Math.round((seen.length / secs) * 10) / 10,
      reactMsPerSec: Math.round((reactMs / secs) * 10) / 10,
      timed, untimed: seen.length - timed,
      performedPerSec: Math.round(performed / secs),
      top: Array.from(byName.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12),
      untimedOrigins: Array.from(untimedByOrigin.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8),
    });
  })()`);
  note(`${label} rest census: ${census}`);
  return (JSON.parse(census) as { rowParsesPerSec: { liveTurn: number } }).rowParsesPerSec.liveTurn;
}

/** One line per reading, and one per sampled process's busiest thread. */
function noteReading(label: string, data: Record<string, unknown>): void {
  const readings = (data.readings ?? []) as SettleReading[];
  note(`${label} streaming: ${JSON.stringify(data.streaming)} · rest ${JSON.stringify((data.rest as { rest?: unknown })?.rest)}`);
  readings.forEach((r, i) => {
    note(
      `${label} #${i + 1}: window ${JSON.stringify(r.window)}, lead ${r.lead_ms} ms, ` +
        `longest gap ${r.longest_gap_ms} ms, ${r.commits.length} commit(s), ` +
        `main thread ${JSON.stringify(r.main_thread)}, streams ${JSON.stringify(r.streams)}`,
    );
    note(`${label} #${i + 1} motion ${JSON.stringify(r.motion)} land ${JSON.stringify(r.land)}`);
    const largest = (r.commits as WindowCommitNote[]).reduce<WindowCommitNote | null>(
      (big, c) => (big === null || c.react_or_span_ms > big.react_or_span_ms ? c : big),
      null,
    );
    if (largest !== null) {
      note(
        `${label} #${i + 1} largest commit: ${largest.react_or_span_ms} ms (react ${largest.react_ms}), ` +
          `${largest.performed} performed, ${largest.mounted} mounted, top ${JSON.stringify(largest.top.slice(0, 8))}`,
      );
      note(`${label} #${i + 1} largest commit why: ${JSON.stringify(largest.why ?? [])}`);
    }
  });
  const samples = (data.samples ?? []) as { process: string; threads: ThreadPhases[] }[];
  for (const p of samples) {
    const top = p.threads[0];
    if (top === undefined) continue;
    note(
      `${label} sample ${p.process}: ${top.thread} busy ${top.busy} of ${top.samples}, phases ` +
        top.phases.map(([phase, samples]) => `${phase} ${samples}`).join(", "),
    );
  }
}

/** A `settle-gap` row as `deck motion gaps` returns it. */
interface GapRow {
  readonly at: number;
  readonly startBeat: string;
  readonly endBeat: string;
  readonly class: string;
  readonly gapMs: number;
  readonly periodMs: number;
  readonly offsetMs: number;
}

/** The gap ring as `deck motion gaps` returns it. */
function readGaps(port: string): { now: number; rows: GapRow[] } {
  const gaps = deckMotion(port, ["gaps"]);
  expect(gaps.exit, `deck motion gaps: ${gaps.stderr}`).toBe(0);
  const data = (gaps.json?.data ?? null) as { now?: number; rows?: GapRow[] } | null;
  expect(Array.isArray(data?.rows), `deck motion gaps carries rows: ${JSON.stringify(gaps.json)}`).toBe(true);
  expect(typeof data?.now, "deck motion gaps carries its clock").toBe("number");
  return { now: data!.now!, rows: data!.rows! };
}

/**
 * Note the rows recorded after `since`: the judders, which the one-period bar
 * reads, apart from the gaps a set-up ended in, which are the lead's budget.
 * Every row must carry both beats and a class.
 */
function noteGapRows(label: string, rows: readonly GapRow[], since: number): void {
  const mine = rows.filter((r) => r.at > since);
  for (const r of mine) {
    expect(typeof r.startBeat, `${label}: a gap row carries its start beat`).toBe("string");
    expect(typeof r.endBeat, `${label}: a gap row carries its end beat`).toBe("string");
    expect(["lead", "judder"], `${label}: a gap row is classed`).toContain(r.class);
  }
  const judder = mine.filter((r) => r.class === "judder");
  const lead = mine.filter((r) => r.class === "lead");
  const sum = (rs: readonly GapRow[]) => Math.round(rs.reduce((s, r) => s + r.gapMs, 0) * 10) / 10;
  const worst = judder.reduce<GapRow | null>((w, r) => (w === null || r.gapMs > w.gapMs ? r : w), null);
  note(
    `${label}: judder ${judder.length} over the one-period bar, ${sum(judder)} ms in all` +
      (worst === null
        ? ""
        : `, worst ${worst.gapMs.toFixed(1)} ms (${(worst.gapMs / worst.periodMs).toFixed(1)} frames) ${worst.startBeat}→${worst.endBeat}`) +
      `; lead ${lead.length} gap(s), ${sum(lead)} ms`,
  );
  note(
    `${label} rows: ` +
      JSON.stringify(mine.map((r) => [r.class, `${r.startBeat}→${r.endBeat}`, Math.round(r.gapMs * 10) / 10, Math.round(r.offsetMs)])),
  );
}

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0725 — the settle reading with three sessions streaming [${arm.size}]`,
  () => {
    test(
      "fold and slot read end to end under three streams, quiet for the record and instrumented for attribution",
      async () => {
        const stubDir = stubDirectory();
        const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME, {
          transcripts: arm.size,
          whaleCards: [SUBJECT],
          resumeCards: [SUBJECT],
          leadRecorder: true,
          env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
        });
        try {
          const stubs = await bindStreamingStubs(app, STREAMERS, stubDir);
          await Bun.sleep(AFTER_LAND_MS);

          const port = await portOf(app);
          const enable = deckMotion(port, ["enable"]);
          expect(enable.exit, `deck motion enable: ${enable.stderr}`).toBe(0);

          // The fold on a deck with no stream, before any starts: the planning
          // commit pane chrome is memoized against is read here, beside the
          // streaming arm rather than as its verdict. Instrumented, with the
          // lead recorder, so labelled.
          const quiet = deckMotion(port, [
            "settle",
            ...GESTURES[0]!.flags,
            "--count",
            String(COUNT),
            "--tasks",
            "--streaming",
            "0",
          ]);
          expect(quiet.exit, `quiet fold exited ${quiet.exit}: ${quiet.stderr} ${JSON.stringify(quiet.json)}`).toBe(0);
          noteReading(`at0725 [${arm.size}] no-stream fold (instrumented: tasks)`, (quiet.json?.data ?? {}) as Record<string, unknown>);
          await Bun.sleep(AFTER_LAND_MS);

          await startStreams(app, stubs);
          await Bun.sleep(AFTER_LAND_MS);
          const liveTurnParses = await noteRestCensus(app, `at0725 [${arm.size}]`);
          expect(liveTurnParses, "the census read the rest").not.toBeNull();
          expect(liveTurnParses, "live-turn row parses per second at rest").toBe(0);

          // One streaming drive set per gesture, its readings checked alike:
          // every drive read under three streams, its window and motion
          // read, and the wire sealed inside the motion.
          const drive = (gesture: (typeof GESTURES)[number], label: string, instruments: string[]) => {
            const run = deckMotion(port, [
              "settle",
              ...gesture.flags,
              "--count",
              String(COUNT),
              ...instruments,
              "--streaming",
              String(STREAMERS.length),
            ]);
            const data = (run.json?.data ?? null) as Record<string, unknown> | null;
            expect(run.exit, `settle ${label} exited ${run.exit}: ${run.stderr} ${JSON.stringify(run.json)}`).toBe(0);
            expect(data).not.toBeNull();
            noteReading(`at0725 [${arm.size}] ${label}`, data!);
            const readings = (data!.readings ?? []) as SettleReading[];
            expect(readings.length, `${label}: every drive read`).toBe(COUNT);
            for (const r of readings) {
              expect(r.streams?.inTurn ?? 0, `${label}: each drive made under three streams`).toBeGreaterThanOrEqual(
                STREAMERS.length,
              );
              expect(r.window, `${label}: the settle mark came off`).not.toBeNull();
              expect(r.motion, `${label}: the motion was read`).not.toBeNull();
              expect(r.motion!.ingest_batches, `${label}: no ingest batch applied inside the motion's gate`).toEqual([]);
            }
            return data!;
          };

          // The reading of record: every gesture driven quiet, and the gap
          // rows those drives recorded read in two-beat form.
          const beforeQuiet = readGaps(port).now;
          for (const gesture of GESTURES) {
            const data = drive(gesture, `${gesture.name} (quiet)`, ["--quiet-instruments"]);
            expect(data.quietInstruments, `${gesture.name}: the quiet drive says it was quiet`).toBe(true);
            expect(data.framesPerturbedByTasks, `${gesture.name}: the quiet drive armed no recorder`).toBe(false);
            expect(data.framesPerturbedBySampling, `${gesture.name}: the quiet drive ran no sampler`).toBe(false);
            await Bun.sleep(AFTER_LAND_MS);
          }
          const quietGaps = readGaps(port);
          noteGapRows(`at0725 [${arm.size}] gap reading (quiet, of record)`, quietGaps.rows, beforeQuiet);

          // Attribution: the same gestures with the instruments on, every
          // reading labelled as instrumented.
          for (const gesture of GESTURES) {
            const data = drive(gesture, `${gesture.name} (instrumented: tasks, sample)`, ["--tasks", "--sample"]);
            const samples = (data.samples ?? []) as unknown[];
            expect(samples.length, `${gesture.name}: the samplers reported`).toBeGreaterThan(0);
            await Bun.sleep(AFTER_LAND_MS);
          }
          const loudGaps = readGaps(port);
          noteGapRows(`at0725 [${arm.size}] gap reading (instrumented: tasks, sample)`, loudGaps.rows, quietGaps.now);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      ARM_TIMEOUT_MS,
    );
  },
);

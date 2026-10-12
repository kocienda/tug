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
 *  - `tugtool deck motion settle --streaming 3 --tasks --sample` is run
 *    against this instance for a fold and for a slot move — the folding and
 *    the switching of columns the report names. `--streaming 3` refuses to
 *    read unless three sessions are mid-turn before every drive.
 *  - `tugtool deck motion gaps` is read after both gestures: the late frames
 *    the always-recorded `settle-gap` row kept across every settle the
 *    gestures drove, on a deck whose trace recording nobody switched on.
 *
 * What it asserts is that the arm runs end to end: every reading taken, each
 * under three streams, with the samplers' phases beside them. The numbers are
 * noted, not barred — this is the baseline the arc's fixes are read against,
 * and its record is the program brief's
 * (`briefs/main-thread-headroom-program-brief.md`).
 *
 * The verb is the bundle's own `tugtool`, built from this tree with the app.
 *
 * @motion
 * @covers tests/app-test/streaming-stub-fixture.ts
 * @covers tugcode/src/stub-replay.ts
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_settle.rs
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_settle.js
 * @covers tugdeck/src/lib/settle-gap-sampler.ts
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { note, type App } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { AFTER_LAND_MS, SHOULD_RUN, blobFor, launch, transcriptArms } from "./settle-frames-fixture";
import {
  STUB_TRANSCRIPT_DIR_ENV,
  bindStreamingStubs,
  startStreams,
  stubDirectory,
} from "./streaming-stub-fixture";

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

interface ThreadPhases {
  readonly thread: string;
  readonly samples: number;
  readonly busy: number;
  /** Busy samples by phase, largest first, as `[phase, samples]`. */
  readonly phases: [string, number][];
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

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0725 — the settle reading with three sessions streaming [${arm.size}]`,
  () => {
    test(
      "fold and slot read end to end under three streams, with tasks and samples",
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
          await startStreams(app, stubs);
          await Bun.sleep(AFTER_LAND_MS);

          const port = await portOf(app);
          const enable = deckMotion(port, ["enable"]);
          expect(enable.exit, `deck motion enable: ${enable.stderr}`).toBe(0);

          for (const gesture of GESTURES) {
            const run = deckMotion(port, [
              "settle",
              ...gesture.flags,
              "--count",
              String(COUNT),
              "--tasks",
              "--sample",
              "--streaming",
              String(STREAMERS.length),
            ]);
            const data = (run.json?.data ?? null) as Record<string, unknown> | null;
            expect(run.exit, `settle ${gesture.name} exited ${run.exit}: ${run.stderr} ${JSON.stringify(run.json)}`).toBe(0);
            expect(data).not.toBeNull();
            noteReading(`at0725 [${arm.size}] ${gesture.name}`, data!);

            const readings = (data!.readings ?? []) as SettleReading[];
            expect(readings.length, `${gesture.name}: every drive read`).toBe(COUNT);
            for (const r of readings) {
              expect(r.streams?.inTurn ?? 0, `${gesture.name}: each drive made under three streams`).toBeGreaterThanOrEqual(
                STREAMERS.length,
              );
              expect(r.window, `${gesture.name}: the settle mark came off`).not.toBeNull();
            }
            const samples = (data!.samples ?? []) as unknown[];
            expect(samples.length, `${gesture.name}: the samplers reported`).toBeGreaterThan(0);
            await Bun.sleep(AFTER_LAND_MS);
          }

          const gaps = deckMotion(port, ["gaps"]);
          expect(gaps.exit, `deck motion gaps: ${gaps.stderr}`).toBe(0);
          const gapData = (gaps.json?.data ?? null) as { rows?: unknown[] } | null;
          expect(Array.isArray(gapData?.rows), `deck motion gaps carries rows: ${JSON.stringify(gaps.json)}`).toBe(true);
          note(`at0725 [${arm.size}] settle-gap rows: ${gapData!.rows!.length} ${JSON.stringify(gapData!.rows)}`);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      ARM_TIMEOUT_MS,
    );
  },
);

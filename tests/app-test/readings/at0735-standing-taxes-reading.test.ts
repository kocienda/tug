/**
 * at0735-standing-taxes-reading.test.ts — what the deck pays at rest while
 * sessions work, priced by phase.
 *
 * A deck with sessions working is never quite at rest: the progress dots
 * loop, the streams land, and the composer's native caret has an animator of
 * its own. This file stands up `at0725`'s deck — four session cards, three of
 * them streaming a stubbed turn through tugcast's real feed — and reads the
 * rest with the verb the user's deck is read with, so the readings are one
 * instrument's:
 *
 *  - `deck motion rest --window 3000`, quiet: the update count of record.
 *  - `deck motion list`: the loops running, by name.
 *  - `deck motion rest --window 3000 --frame-phases` with the dots running
 *    and the composer blurred, then again under `demote on` (and `demote off`
 *    straight after, in the same task — a demotion is a hand switch): the
 *    difference is the dots' tick.
 *  - The same reading with the subject card's composer focused: a forced
 *    layout there that the blurred reading lacks is the caret's.
 *  - Each priced reading carries the GC's share of the busy samples and
 *    WebContent's resident size.
 *
 * What it asserts is that the arm runs end to end: every reading taken under
 * three streams, each priced reading filed with samples, and the deck left
 * un-demoted. The numbers are noted, not barred — the rulings they feed are
 * written in `briefs/engine-time-in-the-motion-readings.md`.
 *
 * The verb is the bundle's own `tugtool`, built from this tree with the app.
 *
 * @foreground — the off-screen rule stills every loop on an occluded window,
 * and the dots' tick is one of the costs read, so the launch takes the screen
 * (`foreground: true` below).
 *
 * @motion
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_phases.rs
 * @covers tugrust/crates/tugtool/src/commands/deck_motion.rs
 * @covers tugdeck/src/lib/motion-guard/geometry-chain-probe.ts
 * @covers tugdeck/src/lib/motion-guard/render-cost-probe.ts
 * @covers tugdeck/src/components/tugways/internal/tug-progress-pulsing-dot.css
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

const TEST_NAME = "at0735-standing-taxes-reading";
const ARMS = transcriptArms();

/** The card whose composer is focused, and the three that stream. */
const SUBJECT = "at0622-c1";
const STREAMERS = ["at0622-c2", "at0622-c3", "at0622-c4"] as const;

/** Each rest window, in ms. */
const WINDOW_MS = "3000";

const ARM_TIMEOUT_MS = 600_000;

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
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(run.stdout.toString()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { exit: run.exitCode ?? -1, json, stderr: run.stderr.toString() };
}

interface PhaseCount {
  readonly engine: number;
  readonly forced: number;
}

interface RestPhases {
  readonly window_ms: number;
  readonly samples: number;
  readonly phases: Record<string, PhaseCount>;
  readonly forcers: { api: string; fn: string | null; samples: number }[];
  readonly stalls: { t: number; len: number; samples: number; phases: Record<string, PhaseCount> }[];
  readonly rss_kb: number | null;
}

/** One priced rest reading, noted in one line per fact the rulings read. */
function pricedRest(port: string, label: string): RestPhases {
  const run = deckMotion(port, ["rest", "--window", WINDOW_MS, "--frame-phases"]);
  expect(run.exit, `rest --frame-phases (${label}): ${run.stderr} ${JSON.stringify(run.json)}`).toBe(0);
  const data = (run.json?.data ?? null) as { rest: Record<string, unknown>; frame_phases: RestPhases } | null;
  expect(data?.frame_phases, `${label}: the reading was filed`).toBeDefined();
  const rp = data!.frame_phases;
  expect(rp.samples, `${label}: the window has samples`).toBeGreaterThan(0);
  const total = (p: string) => (rp.phases[p]?.engine ?? 0) + (rp.phases[p]?.forced ?? 0);
  const split = (p: string) => `${rp.phases[p]?.engine ?? 0}/${rp.phases[p]?.forced ?? 0}`;
  const gc = total("gc");
  note(
    `at0735 ${label}: rest ${JSON.stringify(data!.rest)}; ${rp.samples} busy sample(s) over ${rp.window_ms} ms; ` +
      `style ${split("style")}, layout ${split("layout")}, compositing ${split("compositing")} (engine/forced); ` +
      `layer commit ${total("layer commit")}, paint ${total("paint")}, script ${total("script")}, ` +
      `rendering update ${total("rendering update")}, other ${total("other")}; ` +
      `gc ${gc} (${((100 * gc) / rp.samples).toFixed(1)}% of busy); ` +
      `RSS ${rp.rss_kb === null ? "—" : `${Math.round(rp.rss_kb / 1024)} MB`}`,
  );
  note(`at0735 ${label} forced by: ${JSON.stringify(rp.forcers)}`);
  note(
    `at0735 ${label} stalls (${rp.stalls.length}): ` +
      JSON.stringify(rp.stalls.map((s) => [Math.round(s.t), s.len, s.samples, s.phases])),
  );
  return rp;
}

/** How many sessions are mid-turn, from the page. */
async function inTurn(app: App): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll('[data-testid="session-card"] [data-slot="tug-progress-pulsing-dot"]').length`,
  );
}

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0735 — the deck's standing taxes, read with three sessions streaming [${arm.size}]`,
  () => {
    test(
      "rest is read quiet, then priced with the dots running, demoted, and with the composer focused",
      async () => {
        const stubDir = stubDirectory();
        const { app, tugbankPath } = await launch(4, blobFor(4), TEST_NAME, {
          transcripts: arm.size,
          whaleCards: [SUBJECT],
          resumeCards: [SUBJECT],
          env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
          foreground: true,
        });
        let port: string | null = null;
        try {
          const stubs = await bindStreamingStubs(app, STREAMERS, stubDir);
          await Bun.sleep(AFTER_LAND_MS);
          port = await portOf(app);
          const enable = deckMotion(port, ["enable"]);
          expect(enable.exit, `deck motion enable: ${enable.stderr}`).toBe(0);

          await startStreams(app, stubs);
          await Bun.sleep(AFTER_LAND_MS);
          note(`at0735 [${arm.size}] dots on the session cards: ${await inTurn(app)}`);

          // The composer blurred for every reading but the caret's.
          await app.evalJS(`(document.activeElement instanceof HTMLElement && document.activeElement.blur(), true)`);

          const quiet = deckMotion(port, ["rest", "--window", WINDOW_MS]);
          expect(quiet.exit, `rest (quiet): ${quiet.stderr}`).toBe(0);
          note(`at0735 [${arm.size}] rest (quiet, of record): ${JSON.stringify(quiet.json?.data)}`);

          // The whole deck: `--within` scopes to its selector's first match,
          // which is the one card that does not stream.
          const list = deckMotion(port, ["list"]);
          expect(list.exit, `list: ${list.stderr}`).toBe(0);
          const census = (list.json?.data ?? {}) as { total?: number; longRunning?: number; entries?: { name: string }[] };
          const byName = new Map<string, number>();
          for (const a of census.entries ?? []) byName.set(a.name, (byName.get(a.name) ?? 0) + 1);
          note(
            `at0735 [${arm.size}] loops on the deck: ${census.longRunning} long-running of ${census.total}; ` +
              JSON.stringify([...byName.entries()].sort((a, b) => b[1] - a[1])),
          );
          // A reading of stilled dots is no reading of the dots: the window
          // took the screen, so the streams' dots loop.
          const dotLoops = [...byName.entries()].filter(([name]) => name.startsWith("tugx-progress-pulsing-dot-"));
          expect(dotLoops.length, "the streaming cards' dots are looping").toBeGreaterThan(0);

          pricedRest(port, `[${arm.size}] dots running, composer blurred`);

          // Who pays for the forced layouts at rest: the chain probe, armed
          // with stacks for one window (an instrument, so labelled), its
          // paying reads ranked by site whether or not they chained.
          const armed = deckMotion(port, ["chains", "--mode", "arm"]);
          expect(armed.exit, `chains arm: ${armed.stderr}`).toBe(0);
          await Bun.sleep(Number(WINDOW_MS));
          const chains = deckMotion(port, ["chains", "--mode", "read"]);
          deckMotion(port, ["chains", "--mode", "disarm"]);
          expect(chains.exit, `chains read: ${chains.stderr}`).toBe(0);
          const reading = (chains.json?.data ?? {}) as {
            entries?: number;
            chains?: number;
            paid?: { functions: string[]; reads: number; ms: number; names: string[] }[];
          };
          expect(Array.isArray(reading.paid), "the chain reading ranks the reads that paid").toBe(true);
          note(
            `at0735 [${arm.size}] reads that paid at rest (instrumented: chains), ${reading.entries} entries, ${reading.chains} chain(s): ` +
              JSON.stringify(reading.paid!.map((p) => [p.functions.slice(0, 4).join(" ← "), p.names, p.reads, Math.round(p.ms * 10) / 10])),
          );

          const on = deckMotion(port, ["demote", "on"]);
          let demoted: RestPhases | null = null;
          try {
            expect(on.exit, `demote on: ${on.stderr}`).toBe(0);
            demoted = pricedRest(port, `[${arm.size}] demoted, composer blurred`);
          } finally {
            const off = deckMotion(port, ["demote", "off"]);
            expect(off.exit, `demote off: ${off.stderr}`).toBe(0);
          }
          expect(demoted).not.toBeNull();
          const stillDemoted = await app.evalJS<boolean>(`document.documentElement.hasAttribute("data-tug-motion-demoted")`);
          expect(stillDemoted, "the deck is left un-demoted").toBe(false);

          await app.evalJS(`(document.querySelector('[data-card-id="${SUBJECT}"] .cm-content').focus(), true)`);
          const focused = await app.evalJS<string>(
            `JSON.stringify({ hasFocus: document.hasFocus(), inComposer: !!document.activeElement?.closest('[data-card-id="${SUBJECT}"] .cm-content'), caretColor: getComputedStyle(document.querySelector('[data-card-id="${SUBJECT}"] .cm-content')).caretColor, caretAnimation: CSS.supports("caret-animation", "manual") })`,
          );
          note(`at0735 [${arm.size}] composer focus: ${focused}`);
          pricedRest(port, `[${arm.size}] dots running, composer focused`);
          await app.evalJS(`(document.activeElement instanceof HTMLElement && document.activeElement.blur(), true)`);
          note(`at0735 [${arm.size}] dots on the session cards at the end: ${await inTurn(app)}`);
        } finally {
          if (port !== null) deckMotion(port, ["disable"]);
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      ARM_TIMEOUT_MS,
    );
  },
);

/**
 * at0733-set-up-one-layout.test.ts — a settle's set-up forces one layout.
 *
 * Between a settle's commit and the motion gate's close, every geometry read
 * the set-up makes is taken in the Last pass's one read phase, ahead of every
 * write. A read anywhere else in that span — a list view's render over the
 * frames' holds, a list view's settled door over the previous one's pins, a
 * focus reveal on the notify — reads over somebody's write and forces a
 * whole-document layout of its own. On the user's aged deck that was five to
 * eight such chains in every gesture's set-up, 23–31 ms the largest
 * (`briefs/engine-time-in-the-motion-readings.md`).
 *
 * The reading is the settle verb's own, the instrument the user's deck is
 * read with: `tugtool deck motion settle --chains --json`, whose
 * `set_up_chains` counts the chain probe's read→write→read chains from the
 * settle mark's on to the gate's last close. Each read drive must show at
 * most one — the commit's own layout, paid by the read phase. `appear` (a
 * picker card arriving into a split column) and `fold` (a session card
 * folding beside a neighbour that grows into the room, then unfolding) are
 * driven on the slice arm and the whale arm alike: a chain count is not a
 * timing, so the whale holds the slice's bar, and a chain only the whale
 * shows is a reader the slice never reached.
 *
 * A red names every set-up chain's time, cost and site — the census drive's,
 * which runs with stacks — so one run names every reader still to convert.
 *
 * `TUG_AT0733_PHASES=1` adds `--frame-phases` (the Time Profiler at 1 ms over
 * the deck's WebContent process) and notes each reading's set-up and first
 * frames by phase. That is a reading for attribution, perturbed by its own
 * instrument; the verdict run leaves it unset.
 *
 * The verb is the bundle's own `tugtool`, built from this tree with the app.
 *
 * It covers the protocol's own modules rather than the settle engine and the
 * list view that use them: both of those already fan out to the selection
 * ceiling, which only ratchets down, and a change to the protocol touches
 * the registry, the apply list or the door's plan.
 *
 * @motion
 * @covers tugdeck/src/lib/fold-crossing.ts
 * @covers tugdeck/src/lib/set-up-apply.ts
 * @covers tugdeck/src/lib/crossing-apply.ts
 * @covers tugdeck/src/components/tugways/focus-reveal.ts
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_settle.rs
 * @covers tugrust/crates/tugtool/src/commands/deck_motion_settle.js
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { note, type App } from "../_harness";
import { rmTempTugbank } from "../_harness/tugbank-helpers";
import {
  AFTER_LAND_MS,
  SHOULD_RUN,
  columnBlob,
  home,
  launch,
  transcriptArms,
  wait,
} from "../settle-frames-fixture";

const TEST_NAME = "at0733-set-up-one-layout";
const ARMS = transcriptArms();
const PHASES = process.env.TUG_AT0733_PHASES === "1";

/** The card the fold moves, and the neighbour that grows into its room. */
const SUBJECT = "at0622-c1";
const NEIGHBOUR = "at0622-c2";

/** Readings per gesture: a fold and its unfold, two arrivals. */
const COUNT = 2;

/** The bar: the commit's own layout, and nothing else. */
const MAX_SET_UP_CHAINS = 1;

const ARM_TIMEOUT_MS = 600_000;

const GESTURES: readonly { name: string; flags: string[] }[] = [
  { name: "appear", flags: ["--gesture", "appear"] },
  { name: "fold", flags: ["--gesture", "fold", "--card", SUBJECT] },
];

/** The bundle's own `tugtool`, beside the app binary the harness launched. */
function tugtoolPath(): string {
  const app = process.env.TUGAPP_DEBUG_PATH;
  if (app === undefined || app === "") {
    throw new Error("TUGAPP_DEBUG_PATH is unset; run this file through `just app-test`");
  }
  return join(dirname(app), "tugtool");
}

async function portOf(app: App): Promise<string> {
  const port = await app.evalJS<string>("location.port");
  if (!/^\d+$/.test(port)) throw new Error(`the page reports no tugcast port: '${port}'`);
  return port;
}

function deckMotion(
  port: string,
  args: string[],
): { exit: number; json: Record<string, unknown> | null; stderr: string } {
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

interface ChainSite {
  readonly t: number;
  readonly ms: number;
  readonly site: string;
}

interface PhaseCount {
  readonly engine: number;
  readonly forced: number;
}

interface FrameReading {
  readonly frame: string;
  readonly t: number;
  readonly len: number;
  readonly phases: Record<string, PhaseCount>;
  readonly forcers: { api: string; fn?: string | null; samples: number }[];
}

interface Reading {
  readonly gesture: string;
  readonly window: [number, number] | null;
  readonly lead_ms: number | null;
  readonly longest_gap_ms: number | null;
  readonly set_up_chains: number | null;
  readonly set_up_chain_sites: ChainSite[] | null;
  /** The chain probe's own reading: each chain's paying read with the writes it paid for. */
  readonly chains?: {
    chainTimes?: { ms: number; site: string; writes?: { name: string; site: string }[] }[];
  } | null;
  readonly frame_phases?: { frames: FrameReading[] } | null;
}

/** The first frame of a stack, trimmed. */
function firstFrame(stack: string): string {
  return stack.split("\n")[0]?.trim() ?? "";
}

/**
 * One line per chain: when, how long, the paying read's site, and — when the
 * probe's own reading carries it — the writes it paid for, which name what
 * dirtied the layout between the chain's two reads.
 */
function sitesText(
  sites: readonly ChainSite[] | null | undefined,
  probe?: Reading["chains"],
): string {
  if (sites === null || sites === undefined || sites.length === 0) return "  (none)";
  return sites
    .map((c) => {
      const raw = probe?.chainTimes?.find(
        (p) => Math.abs(p.ms - c.ms) < 0.01 && c.site.endsWith(firstFrame(p.site)),
      );
      const writes = (raw?.writes ?? [])
        .slice(0, 3)
        .map((w) => `${w.name} at ${firstFrame(w.site)}`)
        .join("; ");
      return (
        `  t ${c.t.toFixed(1)} ms · ${c.ms.toFixed(1)} ms · ${c.site.split("\n").slice(0, 3).join(" ← ")}` +
        (writes !== "" ? `\n      after writes: ${writes}` : "")
      );
    })
    .join("\n");
}

/** A frame's phases, `name engine/forced`, the busy ones only. */
function phasesText(f: FrameReading): string {
  const busy = Object.entries(f.phases)
    .filter(([, c]) => c.engine + c.forced > 0)
    .map(([name, c]) => `${name} ${c.engine}/${c.forced}`)
    .join(", ");
  const forcers = f.forcers
    .map((x) => `${x.api}${x.fn ? ` in ${x.fn}` : ""} (${x.samples})`)
    .join("; ");
  return `${f.frame} t ${f.t.toFixed(0)} len ${f.len.toFixed(0)}: ${busy || "idle"}${forcers ? ` — forced by ${forcers}` : ""}`;
}

for (const arm of ARMS) describe.skipIf(!SHOULD_RUN || arm.skip)(
  `at0733 — the set-up forces one layout [${arm.size}]`,
  () => {
    test(
      "appear and fold each read at most one chain between the settle mark and the gate's close",
      async () => {
        const { app, tugbankPath } = await launch(8, columnBlob(), TEST_NAME, {
          transcripts: arm.size,
          whaleCards: [SUBJECT, NEIGHBOUR],
        });
        try {
          await home(app);
          // The subject's column split, so the fold has a neighbour that
          // grows into its room and the appear has a division to arrive at.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("set-column-mode", ` +
              `{ slot: 0, mode: "split" }), null)`,
          );
          await wait(AFTER_LAND_MS);

          const port = await portOf(app);
          const enable = deckMotion(port, ["enable"]);
          expect(enable.exit, `deck motion enable: ${enable.stderr}`).toBe(0);

          const failures: string[] = [];
          for (const gesture of GESTURES) {
            const label = `${gesture.name} [${arm.size}]`;
            const run = deckMotion(port, [
              "settle",
              ...gesture.flags,
              "--count",
              String(COUNT),
              "--chains",
              "--streaming",
              "0",
              ...(PHASES ? ["--frame-phases"] : []),
            ]);
            expect(run.exit, `settle ${label} exited ${run.exit}: ${run.stderr} ${JSON.stringify(run.json)}`).toBe(0);
            const data = (run.json?.data ?? null) as Record<string, unknown> | null;
            expect(data, `settle ${label}: a JSON envelope`).not.toBeNull();
            const census = (data!.chainsCensusSetUp ?? null) as ChainSite[] | null;
            const readings = (data!.readings ?? []) as Reading[];
            expect(readings.length, `${label}: every drive read`).toBe(COUNT);
            note(
              `at0733 ${label} census drive (stacks): ${census?.length ?? "—"} chain(s) in the set-up\n${sitesText(census)}`,
            );
            readings.forEach((r, i) => {
              note(
                `at0733 ${label} #${i + 1} ${r.gesture}: set-up chains ${r.set_up_chains ?? "—"}, ` +
                  `lead ${r.lead_ms?.toFixed(1) ?? "—"} ms, longest gap ${r.longest_gap_ms?.toFixed(1) ?? "—"} ms\n` +
                  sitesText(r.set_up_chain_sites, r.chains),
              );
              if (PHASES && r.frame_phases) {
                note(
                  `at0733 ${label} #${i + 1} ${r.gesture} frame phases (instrumented)\n` +
                    r.frame_phases.frames.slice(0, 4).map((f) => `  ${phasesText(f)}`).join("\n"),
                );
              }
              if (r.set_up_chains === null) {
                failures.push(`${label} #${i + 1} ${r.gesture}: no gate close, so no set-up to count`);
              } else if (r.set_up_chains > MAX_SET_UP_CHAINS) {
                failures.push(
                  `${label} #${i + 1} ${r.gesture}: ${r.set_up_chains} chains in the set-up (bar ${MAX_SET_UP_CHAINS})\n` +
                    `${sitesText(r.set_up_chain_sites, r.chains)}\n  census drive's, with stacks:\n${sitesText(census)}`,
                );
              }
            });
            await wait(AFTER_LAND_MS);
          }
          deckMotion(port, ["disable"]);
          expect(failures, `every set-up reads geometry once:\n${failures.join("\n")}`).toEqual([]);
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      ARM_TIMEOUT_MS,
    );
  },
);

/**
 * at0510-dead-owner-clocked.test.ts — an arc whose owner is not live is
 * judged by the instance that holds its binding, so it is never stuck forever.
 *
 * ## Why this exists
 *
 * On 2026-09-02 a second `Tug.app` instance over one checkout wrote a durable
 * `Stalled` stop receipt for an arc the first was driving: it could not get a
 * session snapshot for a seat living in the other tugcast's process and read
 * that blindness as silence. The fix is the ownership gate — an `arc-owner`
 * line in the shared arc log, and the owner's own tmux server answering — and
 * `at0510-foreign-live-owner` drives the half of it that stands down while the
 * owner is live.
 *
 * This file is the other half, and it is what makes that one falsifiable.
 * Without it the negative would pass equally well against a machine that had
 * simply stopped judging anything at all: the same foreign instance, the same
 * seeded binding and the same one-second stall deadline must STOP the arc
 * once the owner the log names is not live.
 *
 * Both files were one, `at0510-arc-ownership-two-instances`, which launched
 * the owner, closed it and reaped its tmux server before this arm. The gate
 * cannot tell that from an owner that never ran: `arc_ownership::verdict`
 * reads the owner line and asks the owner's `tug-<token>` server for a
 * `cc-<id>` session, and both a reaped server and one never started answer
 * `ForeignDead`. So here the owner is an instance id that was never launched,
 * its tmux liveness is asserted false through the gate's own probe, and the
 * second launch is gone.
 *
 * ## What is asserted through the arc log rather than the shell ledger
 *
 * A stop writes an `arc-stop` line in the arc log and a receipt row in the
 * instance's shell ledger. Only the first is read: there is no harness
 * affordance for the shell ledger, and pointing a foreign sqlite at a live
 * per-instance ledger is forbidden by house rule.
 *
 * @family at0510
 * @covers tugrust/crates/tugcast/src/feeds/arc_ownership.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugrust/crates/tugarc-core/src/arc.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  appendArcLogLine,
  createArc,
  arcLogPath,
  arcPlanPath,
  fixturePlanDocument,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

const ARC = "at0510-unowned";
/** B's card session — the one the binding is written against. */
const SID_B = "a7c0d1ea-0000-4000-8000-000000000512";
/**
 * The seat named by the arc record. Nothing holds it, which is what puts B's
 * runner on the unseated clock path — the path `[F01]` came down.
 */
const STAGE = "a7c0d1ea-0000-4000-8000-000000000513";

/** FNV-1a 32-bit, lower-hex — `tugcore::instance::short_token_for`. */
function shortToken(instanceId: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(instanceId)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function tmuxLive(instanceId: string): boolean {
  const out = Bun.spawnSync([
    "tmux",
    "-L",
    `tug-${shortToken(instanceId)}`,
    "has-session",
    "-t",
    `cc-${instanceId}`,
  ]);
  return out.exitCode === 0;
}

function reapTmux(instanceId: string): void {
  Bun.spawnSync(["tmux", "-L", `tug-${shortToken(instanceId)}`, "kill-server"]);
}

let scratch: ArcScratchRepo | null = null;
let arcId = "";
const fixtureDirs: string[] = [];
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0510-dead",
    checkout: CHECKOUT,
    // A second, not half an hour. `CLOCK_POLL` is a minute precisely so a
    // lowered `arc_stall_secs` is testable.
    files: { ".tugtool/config.toml": "[tugtool.arc]\narc_stall_secs = 1\n" },
  });
  arcId = createArc(projectDir(), ARC, "at0510 unowned arc", scratch.cli).id;
  writeFileSync(arcPlanPath(projectDir(), ARC), fixturePlanDocument(3, ["done"]));
  fixtureDirs.push(seedScratchSession(projectDir(), SID_B));
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  for (const dir of fixtureDirs) rmScratchSession(dir);
});

async function awaitDeck(app: App): Promise<void> {
  await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
}

/** The arc generation, written straight into the shared arc log, as at0503 does. */
function seedTheArc(ownerInstanceId: string): void {
  const log = arcLogPath(scratch?.dataRoot ?? "");
  appendArcLogLine(log, ARC, "arc-start", `.tug/arcs/${ARC}/plan.md`);
  appendArcLogLine(log, ARC, "arc-kind", "planned");
  appendArcLogLine(log, ARC, "arc-owner", ownerInstanceId);
  appendArcLogLine(log, ARC, "arc-stage", `implement ${STAGE} opus`);
}

/** Every `arc-stop` line this arc carries, as the log actually holds them. */
function arcStopLines(): string[] {
  const log = arcLogPath(scratch?.dataRoot ?? "");
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.includes(`  ${ARC}  `) && line.includes("arc-stop"));
}

// Kept local: every file's `arcReport` reads the fields its own arc assertions
// need, so the name is shared and the function is not.
function arcReport(): { stopped: [string, string] | null; stages: number } {
  const out = JSON.parse(
    tugtool(["arc", "record", ARC, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as { data: { arc: { stopped: [string, string] | null; stages: unknown[] } | null } };
  const arc = out.data.arc;
  if (arc === null) return { stopped: null, stages: 0 };
  return { stopped: arc.stopped, stages: arc.stages.length };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A write into the project, which would be a changeset recompute and so a
 * sweep on an instance that had registered the project's workspace. B has
 * not — only a real spawn registers one, and B's card is never spawned — so
 * measured, these wake nothing: the stop lands on B's first `CLOCK_POLL`
 * tick, a minute after its engine started (59 s on 2026-10-16). They are kept
 * because they cost nothing and make the file correct on a build whose
 * aggregate does learn the project from the seeded row.
 */
async function nudgeSweeps(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    writeFileSync(join(projectDir(), `at0510-nudge-${Date.now()}-${i}.txt`), `${Date.now()}\n`);
    await settle(1_500);
  }
}

describe.skipIf(!SHOULD_RUN)("AT0510: an arc whose owner is gone is judged", () => {
  test(
    "a dead owner's arc is clocked by the instance that holds its binding",
    async () => {
      const prefix = process.env.TUG_APPTEST_ID_PREFIX ?? "apptest";
      // The owner the log names: an instance id nothing ever launched.
      const idA = `${prefix}-own-a-${randomUUID()}`;
      const idB = `${prefix}-own-b-${randomUUID()}`;
      const bankB = mkTempTugbank();
      seedTugbankForLaunch(bankB, { sourceTreePath: CHECKOUT });
      const dataRoot = scratch?.dataRoot ?? "";

      let appB: App | null = null;
      try {
        seedTheArc(idA);
        expect(tmuxLive(idA), "the owner the log names is not live").toBe(false);

        appB = await launchTugApp({
          testName: "at0510-dead-owner-B",
          instanceId: idB,
          env: { TUGBANK_PATH: bankB, TUG_DATA_DIR: dataRoot },
        });
        await awaitDeck(appB);
        // Seeded after launch, because `demote_live_to_closed` flips every
        // live row at startup.
        appB.seedLedger({
          sessions: [
            {
              session_id: SID_B,
              workspace_key: projectDir(),
              project_dir: projectDir(),
              card_id: "A",
              line_id: SID_B,
              arc_id: arcId,
              arc_name: ARC,
            },
          ],
        });
        note(`at0510: B up and bound to an arc owned by ${idA}, which is not live`);

        const startedAt = Date.now();
        const deadline = startedAt + 120_000;
        for (;;) {
          await nudgeSweeps(1);
          if (arcStopLines().length > 0) break;
          if (Date.now() >= deadline) break;
        }
        const after = arcReport();
        note(
          `at0510 after ${Math.round((Date.now() - startedAt) / 1000)}s with a dead owner: ${JSON.stringify(after)}`,
        );
        expect(after.stopped, "a dead owner's arc is reachable, or it is stuck forever").toEqual([
          "implement",
          "stalled",
        ]);
      } finally {
        if (appB) await appB.close();
        reapTmux(idA);
        reapTmux(idB);
        rmTempTugbank(bankB);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

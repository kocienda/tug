/**
 * at0510-arc-ownership-two-instances.test.ts — two live instances over one
 * checkout, and the one that did not seat the arc never judges it.
 *
 * ## Why this exists
 *
 * On 2026-09-02 two `Tug.app` instances were live over one checkout. The
 * second — a debug instance launched by an unrelated acceptance test —
 * acquired its own binding to an arc the first was driving, could not get a
 * session snapshot for a seat living in the other tugcast's process, read that
 * blindness as *the stage went silent*, and at the stall deadline wrote the
 * arc a durable `Stalled` stop receipt. The arc was alive and twenty-seven
 * minutes into a healthy audit.
 *
 * The ownership gate is unit-tested in `arc_ownership.rs` and in
 * `arc_runner.rs`. What a unit test cannot reach is the thing that actually
 * failed: two real tugcast processes, two real tmux servers, one shared
 * dash-log. This file drives that.
 *
 * ## The two premises, proved before anything is asserted
 *
 * Both were open questions when this file was written, and the answers are
 * recorded here so a later reader does not have to re-derive them:
 *
 *   - **Two instances can be live at once.** Every other multi-launch test in
 *     the corpus is sequential — Phase A quits before Phase B starts — so
 *     nothing demonstrated concurrency. They coexist: distinct instance ids
 *     mint distinct data dirs, tugbanks, ports, and tmux socket labels.
 *   - **A launched instance makes itself tmux-live.** The gate's liveness
 *     probe asks the owner's own `tug-<token>` server for a `cc-<id>` session,
 *     and an app-test launch really does create one. Had it not, a live
 *     foreign owner would read as dead and this whole file would prove
 *     nothing.
 *
 * ## The arc is bound on B alone, and that is deliberate
 *
 * The plan called for a binding on each instance. Binding on A as well would
 * make A's own runner judge its own arc — and with the stall deadline lowered
 * far enough for B to have crossed it, A's clock would stop the arc during
 * the very window B is being watched, which is a confound rather than a
 * fidelity gain. `sessions.db` is per-instance, so A carrying no binding
 * simply means A's runner never sweeps the arc.
 *
 * What makes A the owner is what ownership *is*: the `arc-owner` line naming
 * A in the shared dash-log, and A's own tmux server answering. That is
 * exactly the pair the gate reads, and it is what `[F01]` was about — the
 * claim under test is about what the **foreign** runner does.
 *
 * ## What is asserted through the dash-log rather than the shell ledger
 *
 * A stop writes two things: an `arc-stop` line in the dash-log and a receipt
 * row in the instance's shell ledger. Only the first is read here. There is
 * no harness affordance for the shell ledger, and pointing a foreign sqlite
 * at a live per-instance ledger is forbidden by house rule. The dash-log is
 * the same event's durable record, it is plain text, and — the part that
 * matters — the same read turning **positive** in the last phase is what
 * proves this test can fail.
 *
 * ## What [P04]'s visible half is not asserted here
 *
 * A foreign arc must stay *visible* while going unjudged, and that half is
 * not driven from this file. The Arcs card's aggregate learns a project only
 * through the workspace registration a real spawn performs — a seeded ledger
 * row is not enough, because `rebind_from_ledger` runs at boot and a row
 * seeded after it never reaches the registry — and a spawn on the second
 * instance never readies while the first is live. That is a finding about
 * spawning under two instances rather than about ownership, and chasing it
 * here would trade the claim this file uniquely proves for one already
 * covered elsewhere: the composition is verified in `arc-lifecycle.md`'s
 * ownership section (`DashArcState` is built from `read_arc` alone and
 * consults no session snapshot), and the card's rendering of a dash row is
 * `at0499`'s.
 *
 * @covers tugrust/crates/tugcast/src/feeds/arc_ownership.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugrust/crates/tugarc-core/src/arc.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  appendDashLogLine,
  createDash,
  dashLogPath,
  dashPlanPath,
  fixturePlanDocument,
  makeDashScratchRepo,
  rmDashScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type DashScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

const DASH = "at0510-owned";
/** B's card session — the one the binding is written against. */
const SID_B = "a7c0d1ea-0000-4000-8000-000000000510";
/**
 * The seat named by the arc record. Nothing holds it, which is what puts B's
 * runner on the unseated clock path — the path `[F01]` came down.
 */
const STAGE = "a7c0d1ea-0000-4000-8000-000000000511";

const ARC_RECEIPT = '[data-slot="arc-receipt-block"]';

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

/** What the owner instance going away looks like from the gate's side. */
function reapTmux(instanceId: string): void {
  Bun.spawnSync(["tmux", "-L", `tug-${shortToken(instanceId)}`, "kill-server"]);
}

let scratch: DashScratchRepo | null = null;
let dashId = "";
const fixtureDirs: string[] = [];
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeDashScratchRepo({
    prefix: "at0510",
    checkout: CHECKOUT,
    // A second, not half an hour. `CLOCK_POLL` is a minute precisely so a
    // lowered `arc_stall_secs` is testable — the comment on that constant
    // names this test's shape.
    files: { ".tugtool/config.toml": "[tugtool.dash]\narc_stall_secs = 1\n" },
  });
  dashId = createDash(projectDir(), DASH, "at0510 owned arc", scratch.cli).id;
  // A plan with somewhere left to go, so "the arc was not stopped" is a claim
  // about restraint rather than about an arc that had nothing to do anyway.
  writeFileSync(dashPlanPath(projectDir(), DASH), fixturePlanDocument(3, ["done"]));
  fixtureDirs.push(seedScratchSession(projectDir(), SID_B));
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmDashScratchRepo(scratch);
  for (const dir of fixtureDirs) rmScratchSession(dir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

async function awaitDeck(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
}

/**
 * The arc generation, written straight into the shared dash-log — the same
 * route `at0503` takes, and for the same reason: the verb that writes these
 * lines is the runner, and the runner is what this file is interrupting.
 */
function seedTheArc(ownerInstanceId: string): void {
  const log = dashLogPath(scratch?.dataRoot ?? "");
  appendDashLogLine(log, DASH, "arc-start", `.tug/arcs/${DASH}/plan.md`);
  appendDashLogLine(log, DASH, "arc-kind", "trek");
  appendDashLogLine(log, DASH, "arc-owner", ownerInstanceId);
  appendDashLogLine(log, DASH, "arc-stage", `implement ${STAGE} opus`);
}

/** Every `arc-stop` line this dash carries, as the log actually holds them. */
function arcStopLines(): string[] {
  const log = dashLogPath(scratch?.dataRoot ?? "");
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.includes(`  ${DASH}  `) && line.includes("arc-stop"));
}

function arcReport(): { stopped: [string, string] | null; stages: number } {
  const out = JSON.parse(
    tugtool(["arc", "record", DASH, "--json"], {
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
 * Wake the engine without waiting out `CLOCK_POLL`.
 *
 * The runner sweeps on a changeset recompute as well as on its own minute,
 * and a write into the watched project is what produces one. Several sweeps
 * inside a few seconds is what makes "still nothing" evidence rather than
 * impatience.
 */
async function nudgeSweeps(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    writeFileSync(join(projectDir(), `at0510-nudge-${i}.txt`), `${Date.now()}\n`);
    await settle(1_500);
  }
}

describe.skipIf(!SHOULD_RUN)("AT0510: an arc is judged only by the instance that seated it", () => {
  test(
    "a foreign live owner is never clocked, and a dead one is",
    async () => {
      const prefix = process.env.TUG_APPTEST_ID_PREFIX ?? "apptest";
      const idA = `${prefix}-own-a-${randomUUID()}`;
      const idB = `${prefix}-own-b-${randomUUID()}`;
      const bankA = mkTempTugbank();
      const bankB = mkTempTugbank();
      seedTugbankForLaunch(bankA, { sourceTreePath: CHECKOUT });
      seedTugbankForLaunch(bankB, { sourceTreePath: CHECKOUT });
      const dataRoot = scratch?.dataRoot ?? "";

      let appA: App | null = null;
      let appB: App | null = null;
      try {
        // ── A: the instance that seats the arc ────────────────────────────
        appA = await launchTugApp({
          testName: "at0510-owner-A",
          instanceId: idA,
          env: { TUGBANK_PATH: bankA, TUG_DATA_DIR: dataRoot },
        });
        await awaitDeck(appA);
        seedTheArc(idA);
        // The premise, asserted rather than assumed: the gate's own probe
        // must answer true for A, or a live owner reads as a dead one and
        // every assertion below passes for the wrong reason.
        expect(tmuxLive(idA), "A is tmux-live, which is what the gate reads").toBe(true);
        note(`at0510: A up and owning the arc as ${idA}`);

        // ── B: the foreign instance, live at the same time ────────────────
        appB = await launchTugApp({
          testName: "at0510-foreign-B",
          instanceId: idB,
          env: { TUGBANK_PATH: bankB, TUG_DATA_DIR: dataRoot },
        });
        await awaitDeck(appB);
        // The binding is seeded, not spawned. B's runner sweeps whatever its
        // own ledger says is bound, and that is all this test needs — the
        // card need not be seated, and `session_snapshot` answering `None`
        // for a seat no supervisor here holds is precisely the unseated path
        // `[F01]` came down. Seeded *after* launch, because
        // `demote_live_to_closed` flips every live row at startup.
        //
        // A spawn was tried first and B's engine never readied with A live;
        // that is a finding about spawning under two instances, and it is
        // not on this test's path.
        appB.seedLedger({
          sessions: [
            {
              session_id: SID_B,
              workspace_key: projectDir(),
              project_dir: projectDir(),
              card_id: "A",
              line_id: SID_B,
              dash_id: dashId,
              dash_name: DASH,
            },
          ],
        });
        note(`at0510: B up and bound to the arc as ${idB}, with A still live`);

        // ── The claim: B watches and writes nothing ───────────────────────
        await nudgeSweeps(6);
        expect(arcStopLines(), "B wrote no stop for an arc it does not own").toEqual([]);
        const during = arcReport();
        expect(during.stopped, "the arc is untouched").toBeNull();
        expect(during.stages, "and still seated on its stage").toBe(1);
        const receipts = await appB.evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(ARC_RECEIPT)}).length`,
        );
        expect(receipts, "and no receipt reached B's card").toBe(0);

        // ── A goes away, and the arc becomes B's to clock ─────────────────
        //
        // Without this arm the test would pass equally well against a machine
        // that had simply stopped judging anything at all.
        await appA.close();
        appA = null;
        reapTmux(idA);
        expect(tmuxLive(idA), "the owner is gone").toBe(false);
        note("at0510: A is down; the arc is now B's to judge");

        const deadline = Date.now() + 120_000;
        for (;;) {
          await nudgeSweeps(4);
          if (arcStopLines().length > 0) break;
          if (Date.now() >= deadline) break;
        }
        const after = arcReport();
        note(`at0510 after the owner died: ${JSON.stringify(after)}`);
        expect(after.stopped, "a dead owner's arc is reachable, or it is stuck forever").toEqual([
          "implement",
          "stalled",
        ]);
      } finally {
        if (appB) await appB.close();
        if (appA) await appA.close();
        reapTmux(idA);
        reapTmux(idB);
        rmTempTugbank(bankA);
        rmTempTugbank(bankB);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

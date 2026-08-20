/**
 * AT0426 — the audit catches a machine resolution that discards one side.
 *
 * ## The incident this guards
 *
 * From the 2026-08-15 join, recorded in this file's ancestor: *a stale rerere
 * entry can keep one side wholesale and discard the other — **green build,
 * green tests**, broken at runtime.* That sentence is why a human review gate
 * existed, and it is also why replacing that gate with build-and-test
 * verification alone would have been a downgrade rather than a trade:
 * verification, by the incident's own account, does not catch this.
 *
 * What catches it now is the resolver's **audit duty**. The resolver reviews
 * every file the algorithmic rungs decided — rerere, merge-file, driver, the
 * per-file AI rung — against the dash's recorded intent, and its report must
 * account for each one. It may reject and redo any of them. So the same
 * failure class is still guarded; it is guarded one layer down, by the reader
 * that is already holding both sides' content and the intent corpus.
 *
 * ## What is pressed
 *
 * Two arcs, each on its own scratch repository:
 *
 * 1. **The audit runs and redoes.** A stub merge driver resolves the conflict
 *    wholesale, so the ladder reaches a candidate with *nothing left
 *    unresolved* — the exact state where a "finish what the ladder left"
 *    resolver would have had nothing to do and would have been skipped. The
 *    resolver runs anyway, reports `audit: "redone"` for the driver's path, and
 *    rewrites it. The assertion is that the candidate carries the resolver's
 *    body rather than the driver's.
 * 2. **A report that skips a path is refused.** The same ladder-clean setup,
 *    with a resolver that reports nothing at all. The candidate is not
 *    accepted; the face says why, naming the path it did not account for.
 *
 * The first proves the pass happens; the second proves it cannot be skipped by
 * silence. Neither asserts anything about model prose — the resolvers are
 * scripted, and what is checked is bytes and refusals.
 *
 * @covers tugrust/crates/tugcast/src/feeds/join_resolver.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugdash-core/src/resolve.rs
 * @covers tugrust/crates/tugdash-core/src/workshop.rs
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-join.tsx
 * @covers tugdeck/src/lib/join-mode-controller.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  gitRetry as git,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type JoinScratchRepo,
} from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-dash-lane"]`;
const LENS_SECTION = '.lens-section[data-lens-section="dashes"]';

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const FILE = "subject.txt";

/** What the driver keeps — one side, wholesale. The incident's shape. */
const DRIVER_BODY = "at0426 SENTINEL the driver kept the base side whole\n";
/** What the audit puts back — both intents, which is what redoing means. */
const AUDITED_BODY = "at0426 SENTINEL the audit restored both sides\n";

const DRIVER_STUB = `#!/bin/sh\nprintf '%s' '${DRIVER_BODY}' > "$4"\n`;

/** Audits the driver's path, rejects what it did, and says so. */
const AUDITING_RESOLVER = `#!/bin/sh
ws="$1"
read -r _charter
printf '%s' '${AUDITED_BODY}' > "$ws/${FILE}"
printf '%s\\n' '{"files":[{"path":"${FILE}","resolved_by":"resolver","what_each_side_did":"the base and the dash each rewrote it","reconciliation":"restored what the driver discarded","audit":"redone"}],"notes":"at0426 audit"}'
`;

/** Reports nothing — the silence the contract refuses. */
const SILENT_RESOLVER = `#!/bin/sh
read -r _charter
printf '%s\\n' '{"files":[],"notes":"nothing to say"}'
`;


/** One arc's world: its repo, its dash, and the session that opens on it. */
interface Arc {
  scratch: JoinScratchRepo;
  fixtureDir: string;
  sid: string;
  dash: string;
}

function makeArc(prefix: string, dash: string, sid: string, resolver: string): Arc {
  const scratch = makeJoinScratchRepo({
    prefix,
    dash,
    description: `${prefix} audit fixture`,
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0426 the body both sides will rewrite\n",
    base: "at0426 base side — the whole file, rewritten\n",
    dashBody: "at0426 dash side — the whole file, rewritten\n",
    verifyTier0: `grep -q SENTINEL ${FILE}`,
    resolver,
    mergeDriver: DRIVER_STUB,
    // The run this file audits is the pilot's. There is no Resolve to press
    // any more ([P08]), and a dash reaches the resolver by being built.
    built: true,
  });
  const fixtureDir = seedScratchSession(scratch.repo, sid);
  return { scratch, fixtureDir, sid, dash };
}

let audited: Arc | null = null;
let silent: Arc | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  audited = makeArc(
    "at0426a",
    "at0426-audit",
    "a7c0d1ea-0000-4000-8000-000000000426",
    AUDITING_RESOLVER,
  );
  silent = makeArc(
    "at0426b",
    "at0426-silent",
    "a7c0d1ea-0000-4000-8000-000000000427",
    SILENT_RESOLVER,
  );
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  for (const arc of [audited, silent]) {
    if (arc === null) continue;
    rmJoinScratchRepo(arc.scratch);
    rmScratchSession(arc.fixtureDir);
  }
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

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

async function runCommand(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

/** Open the card on an arc's dash and wait for the pilot's run to finish. */
async function resolveArc(app: App, arc: Arc): Promise<string> {
  const row = `${LANE} [data-slot="session-changes-dash-row"][data-dash="${arc.dash}"]`;
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: arc.sid, projectDir: arc.scratch.repo });
  await app.awaitEngineReady("A", { timeoutMs: 15000 });

  await app.dispatchControlAction("toggle-lens");
  await app.waitForCondition<boolean>(
    `document.querySelector('${LENS_SECTION} [data-slot="lens-dashes-row"][data-dash="${arc.dash}"]') !== null`,
    { timeoutMs: 30000 },
  );
  await app.dispatchControlAction("toggle-lens");

  // The dash is `built`, so the pilot reconciles it with nothing pressed.
  // `/dash-join` fronts the row so the audit's own surfaces render; it does
  // not start the run, and on a conflicted dash it never did.
  await runCommand(app, `/dash-join ${arc.dash}`);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(`${row} [data-slot="session-changes-dash-join"]`)}) !== null`,
    { timeoutMs: 40000 },
  );
  return row;
}

describe.skipIf(!SHOULD_RUN)("AT0426: the resolver audits what the machines decided", () => {
  test(
    "a ladder-clean candidate still gets the audit, and the audit can redo it",
    async () => {
      const arc = audited as Arc;
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0426-dash-resolution-audit",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: arc.scratch.dataRoot },
      });
      try {
        await app.enableDeckTrace(true);
        const row = await resolveArc(app, arc);

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${row} [data-slot="session-changes-dash-join-verdict"]`)})?.getAttribute("data-verdict") === "green"`,
          { timeoutMs: 180000 },
        );
        const report = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(`${row} [data-slot="session-changes-dash-join-report"]`)})?.textContent || "")`,
        );
        expect(report, "the report accounts for the path the driver decided").toContain(
          FILE,
        );
        expect(report, "and says what it did about it").toContain("restored what the driver");

        // The bytes are the assertion. The driver resolved the conflict on its
        // own — the ladder had nothing left to hand anybody — and the candidate
        // still carries the audit's body, which is only possible if the pass
        // ran over a file nobody had asked it to finish.
        const merged = git(arc.scratch.repo, "show", `refs/tug/join/${arc.dash}:${FILE}`);
        expect(merged, "the audit's resolution is what would join").toBe(AUDITED_BODY);
        expect(merged, "and the driver's wholesale keep is not").not.toBe(DRIVER_BODY);
        note("at0426 audit: a ladder-clean candidate was reviewed and redone");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a report that does not account for a resolved path is refused, by name",
    async () => {
      const arc = silent as Arc;
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0426-dash-resolution-audit-silence",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: arc.scratch.dataRoot },
      });
      try {
        await app.enableDeckTrace(true);
        const row = await resolveArc(app, arc);

        // Silence about a file the machines resolved is exactly the failure
        // the audit exists to catch, so it is a contract violation rather than
        // an empty report — and the refusal names the path.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${row} [data-slot="session-changes-dash-join-stuck"]`)}) !== null`,
          { timeoutMs: 180000 },
        );
        const stuck = await app.evalJS<string>(
          `(document.querySelector(${JSON.stringify(`${row} [data-slot="session-changes-dash-join-stuck"]`)})?.textContent || "")`,
        );
        expect(stuck, "the refusal names what went unaccounted for").toContain(FILE);
        expect(stuck, "in the contract's own words").toContain("does not account for");
        note(`at0426 silence refused: ${JSON.stringify(stuck)}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

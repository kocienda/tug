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
 * per-file AI rung — against the arc's recorded intent, and its report must
 * account for each one. It may reject and redo any of them. So the same
 * failure class is still guarded; it is guarded one layer down, by the reader
 * that is already holding both sides' content and the intent corpus.
 *
 * ## What is pressed
 *
 * One arc, on its own scratch repository: **a report that skips a path is
 * refused.** A stub merge driver resolves the conflict wholesale, so the
 * ladder reaches a candidate with *nothing left unresolved* — the exact state
 * where a "finish what the ladder left" resolver would have had nothing to do
 * and would have been skipped. The resolver runs anyway and reports nothing at
 * all. The candidate is not accepted; the face says why, naming the path it
 * did not account for.
 *
 * So what is guarded here is that the pass cannot be skipped by silence.
 * Nothing asserts anything about model prose — the resolver is scripted, and
 * what is checked is a refusal.
 *
 * @covers tugrust/crates/tugcast/src/feeds/join_resolver.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/changeset.rs
 * @covers tugrust/crates/tugarc-core/src/resolve.rs
 * @covers tugrust/crates/tugarc-core/src/workshop.rs
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-join.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-fold-row.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-fold.css
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugrust/crates/tugcast/src/feeds/join_ledger.rs
 * @covers tugrust/crates/tugcast/src/feeds/join_board.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { kindBody } from "./_harness/card-reach";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindArc,
  silenceJoinPrompt,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type JoinScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="session-changes-view"]';
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;
const ARCS_CARD = '.arcs-section';

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const FILE = "subject.txt";

/** What the driver keeps — one side, wholesale. The incident's shape. */
const DRIVER_BODY = "at0426 SENTINEL the driver kept the base side whole\n";
const DRIVER_STUB = `#!/bin/sh\nprintf '%s' '${DRIVER_BODY}' > "$4"\n`;

/** Reports nothing — the silence the contract refuses. */
const SILENT_RESOLVER = `#!/bin/sh
read -r _charter
printf '%s\\n' '{"files":[],"notes":"nothing to say"}'
`;

/** One arc's world: its repo, its arc, and the session that opens on it. */
interface Arc {
  scratch: JoinScratchRepo;
  fixtureDir: string;
  sid: string;
  arc: string;
}

function makeArc(prefix: string, arc: string, sid: string, resolver: string): Arc {
  const scratch = makeJoinScratchRepo({
    prefix,
    arc,
    description: `${prefix} audit fixture`,
    checkout: CHECKOUT,
    file: FILE,
    fork: "at0426 the body both sides will rewrite\n",
    base: "at0426 base side — the whole file, rewritten\n",
    arcBody: "at0426 arc side — the whole file, rewritten\n",
    resolver,
    mergeDriver: DRIVER_STUB,
    // The run this file audits is the pilot's. There is no Resolve to press
    // any more ([P08]), and an arc reaches the resolver by being built.
    built: true,
  });
  const fixtureDir = seedScratchSession(scratch.repo, sid);
  return { scratch, fixtureDir, sid, arc };
}

let silent: Arc | null = null;

beforeAll(() => {
  if (!SHOULD_RUN) return;
  silent = makeArc(
    "at0426b",
    "at0426-silent",
    "a7c0d1ea-0000-4000-8000-000000000427",
    SILENT_RESOLVER,
  );
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  if (silent === null) return;
  rmJoinScratchRepo(silent.scratch);
  rmScratchSession(silent.fixtureDir);
});

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

async function runCommand(app: App, line: string): Promise<void> {
  await app.body("A").nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

/**
 * Open the card on an arc's run and front its row, leaving the pilot to run.
 *
 * The gate is the ROW, not the report under it. The report section speaks only
 * when it has evidence to show — a standing candidate that has resolved nothing
 * and filed no account yet is silence, deliberately, so a clean arc does not
 * wear an eyebrow over an empty box. Each test below waits on the slot carrying
 * its own claim, with the pilot's whole run in its budget.
 */
async function resolveArc(app: App, arc: Arc): Promise<string> {
  const row = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${arc.arc}"]`;
  await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: arc.sid, projectDir: arc.scratch.repo });
  await app.awaitEngineReady("A", { timeoutMs: 15000 });
  // The pilot only works an arc somebody holds ([D147]); without the ledger
  // row the audit has no candidate to audit.
  bindArc(arc.scratch.repo, arc.arc, arc.sid, arc.scratch.cli);
  silenceJoinPrompt(arc.scratch.repo, arc.arc);

  await app.dispatchControlAction("toggle-arcs");
  await kindBody(app, "dashes").waitForCondition<boolean>(
    `document.querySelector('${ARCS_CARD} [data-slot="arcs-row"][data-arc="${arc.arc}"]') !== null`,
    { timeoutMs: 30000 },
  );
  await app.dispatchControlAction("toggle-arcs");

  // The arc is `built`, so the pilot reconciles it with nothing pressed.
  // `/arc-join` fronts the row so the audit's own surfaces render; it does
  // not start the run, and on a conflicted arc it never did.
  await runCommand(app, `/arc-join ${arc.arc}`);
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(row)}) !== null`,
    { timeoutMs: 40000 },
  );
  return row;
}

describe.skipIf(!SHOULD_RUN)("AT0426: the resolver audits what the machines decided", () => {
  test(
    "a report that does not account for a resolved path is refused, by name",
    async () => {
      const arc = silent as Arc;
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0426-arc-resolution-audit-silence",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: arc.scratch.dataRoot },
      });
      try {
        await app.enableDeckTrace(true);
        const row = await resolveArc(app, arc);

        // Silence about a file the machines resolved is exactly the failure
        // the audit exists to catch, so it is a contract violation rather than
        // an empty report — and the refusal names the path.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${row} [data-slot="session-changes-arc-join-stuck"]`)}) !== null`,
          { timeoutMs: 180000 },
        );
        const stuck = await app.body("A").evalJS<string>(
          `(document.querySelector(${JSON.stringify(`${row} [data-slot="session-changes-arc-join-stuck"]`)})?.textContent || "")`,
        );
        expect(stuck, "the refusal names what went unaccounted for").toContain(FILE);
        expect(stuck, "in the contract's own words").toContain("does not account for");
        note(`at0426 silence refused: ${JSON.stringify(stuck)}`);
        // The refusal is one error band at the face's body size, not bare
        // xs red text: the stuck reason rides inside it, once.
        const band = await app.body("A").evalJS<{ bands: number; tone: string | null; size: number; sm: number }>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(row)});
             const bands = row.querySelectorAll('[data-slot="session-changes-arc-join-refusal"]');
             const reason = row.querySelector('[data-slot="session-changes-arc-join-refusal"] [data-slot="session-changes-arc-join-stuck"]');
             const notice = bands[0]?.querySelector('[data-slot="tool-block-notice"]') ?? null;
             const probe = document.createElement("span");
             probe.style.fontSize = "var(--tug-font-size-sm)";
             row.appendChild(probe);
             const sm = parseFloat(getComputedStyle(probe).fontSize);
             probe.remove();
             return {
               bands: bands.length,
               tone: notice?.getAttribute("data-tone") ?? null,
               size: reason === null ? 0 : parseFloat(getComputedStyle(reason).fontSize),
               sm,
             };
           })()`,
        );
        note(`at0426 refusal band: ${JSON.stringify(band)}`);
        expect(band.bands, "the refusal is drawn once").toBe(1);
        expect(band.tone, "as an error band").toBe("error");
        expect(band.size, "at the face's body size").toBe(band.sm);

        // The run's ledger is durable: a reload draws the same blocks, in the
        // same order, from the arc's feed entry alone — the page that watched
        // the run is gone, and so is everything it heard live.
        const kinds = (): Promise<string[]> =>
          app.body("A").evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(`${row} [data-slot^="session-changes-ledger-"]`)})).map((el) => el.getAttribute("data-slot"))`,
          );
        const before = await kinds();
        expect(before.length, "the run left a ledger").toBeGreaterThan(0);
        await app.appReload();
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${row} [data-slot="session-changes-arc-join-stuck"]`)}) !== null`,
          { timeoutMs: 30000 },
        );
        const after = await kinds();
        expect(after, "the reload draws the same ledger").toEqual(before);
        note(`at0426 ledger across reload: ${before.join(", ")}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

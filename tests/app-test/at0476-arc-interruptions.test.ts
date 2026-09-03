/**
 * at0476-arc-interruptions.test.ts — an interrupted arc says what happened on
 * the card the user is watching, and the work is still there to pick back up.
 *
 * ## Why this exists
 *
 * `tuglaws/arc-lifecycle.md`'s Interruptions table promises three things of
 * every interruption: the arc does something sayable, the user sees a receipt,
 * and there is a gesture that resumes. The first and third are records, and
 * the Rust tests pin them. The **second** is a claim about a card, and a claim
 * about a card is only true if the card shows it — which is what this file is
 * for. Each test drives a real `tugtool` verb through the card's own `$` shell
 * route (the route that stamps `TUG_SESSION_ID`, so the server can resolve
 * which card asked) and reads the answer off the real DOM and the real ledger.
 *
 * ## What is here, and what is deliberately not
 *
 * Two of the table's rows are drivable end to end without a claude ever
 * running, and both are here in full — receipt, `--json` state, and a working
 * resume:
 *
 *   - **`tugtool arc stop`** — the verb that means *stop the arc, keep the
 *     arc*, and the receipt that says so.
 *   - **A second `/arc` naming another arc** — refused by name, with the
 *     first arc's binding untouched and its record still live.
 *
 * The rows that turn on a **seated stage** — a cancelled devise turn, and a
 * discard or join reaching the card — are not here, and the reason is not
 * scope. A stage is seated by the wheel writing `stage_label` on the
 * session row at the `session_init` that follows a real rotation; nothing
 * short of a real multi-stage claude run produces one, and a fixture that
 * wrote the column by hand would be asserting against state no code path
 * builds. Those rows are covered where their facts are real: `arc_action`'s
 * table tests for the cancel arm, and `arc_api`'s integration tests over a
 * real ledger for the ending's seated list and its receipt.
 *
 * @covers tugrust/crates/tugcast/src/feeds/arc.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 * @covers tugrust/crates/tugcast/src/arc_api.rs
 * @covers tugrust/crates/tugtool/src/arc.rs
 * @covers tugcode/src/session.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  arcBriefPath,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugtool,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000476";
const CARD = '[data-card-id="A"]';
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const ARC_NAME = "at0476-stop";
const OTHER_ARC = "at0476-other";
const THIRD_ARC = "at0476-third";
/** Every arc's brief lives at its own address, so there is nothing to name. */
const BRIEF_BODY = "# A brief\n\nSome prose the arc opens on.\n";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0476", checkout: CHECKOUT });
  createArc(projectDir(), ARC_NAME, "at0476 stop fixture", scratch.cli);
  createArc(projectDir(), OTHER_ARC, "at0476 second arc", scratch.cli);
  createArc(projectDir(), THIRD_ARC, "at0476 third arc", scratch.cli);
  // The arc opens on the arc's own brief, so each one that runs gets one.
  for (const name of [ARC_NAME, OTHER_ARC]) {
    writeFileSync(arcBriefPath(projectDir(), name), BRIEF_BODY);
  }
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 660 },
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

/**
 * Run a shell command on the card and wait for the transcript to carry
 * `marker`.
 *
 * Not `shellAndSettle`: that waits for an exact row count, and the receipt
 * this file is about **is itself a shell row** ([D111]). A stop that lands its
 * receipt therefore leaves two rows where the count-based wait demanded one,
 * and the wait can never come true — the thing under test defeats the helper
 * that was supposed to observe it. Waiting on the text is indifferent to how
 * many rows the act produced.
 */
async function shellUntil(app: App, command: string, marker: string): Promise<void> {
  const prompt = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
  await app.nativeClickAtElement(prompt);
  await app.nativeType(`/shell ${command}`);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
  await app.waitForCondition<boolean>(
    `Array.from(document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}))
       .some((el) => (el.textContent || "").indexOf(${JSON.stringify(marker)}) !== -1)`,
    { timeoutMs: 60_000 },
  );
}

/** Every shell row's text, in transcript order. */
async function shellRowText(app: App): Promise<string[]> {
  const raw = await app.evalJS<string>(
    `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
      SHELL_ROWS,
    )})).map((el) => el.textContent || ""))`,
  );
  return JSON.parse(raw) as string[];
}

/** What `tugtool arc record --json` says about an arc, read from the fixture. */
function arcReport(name: string): {
  stopped: [string, string] | null;
  resume: string | null;
  done: boolean;
} {
  const out = JSON.parse(
    tugtool(["arc", "record", name, "--json"], {
      cwd: projectDir(),
      binaryRoot: CHECKOUT,
      env: scratch?.cli.env,
    }),
  ) as {
    data: {
      arc: { stopped: [string, string] | null; resume: string | null; done: boolean } | null;
    };
  };
  const arc = out.data.arc;
  if (arc === null) return { stopped: null, resume: null, done: false };
  return { stopped: arc.stopped, resume: arc.resume, done: arc.done };
}

async function openCard(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 30_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
  await app.awaitEngineReady("A", { timeoutMs: 30_000 });
}

describe.skipIf(!SHOULD_RUN)("AT0476: an interrupted arc says so on the card", () => {
  test(
    "arc stop stops the arc, says so on the card, and arc run picks it back up",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0476-arc-interruptions",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app);

        // Opening the arc and stopping it are **one** shell line, and that is
        // not a convenience. A live arc on an idle card is a rotating arc:
        // the runner's next tick seats the first stage. Chaining the two verbs
        // in one process is what puts the interruption where the test means
        // it, rather than wherever the sweep happened to be.
        //
        // The wait is on the receipt itself, which is the claim: the card was
        // told, in words, on the surface the user is watching.
        await shellUntil(
          app,
          `${cli} arc run ${ARC_NAME} --plan && ${cli} arc stop ${ARC_NAME}`,
          "you stopped it",
        );

        // The record says it, in the closed vocabulary. Stable to re-read: a
        // stopped arc is not advanced by a tick.
        const stopped = arcReport(ARC_NAME);
        note("at0476 arc after stop", JSON.stringify(stopped));
        expect(stopped.stopped?.[1]).toBe("stopped by user");
        expect(stopped.done).toBe(false);

        // And the card says it, as a shell-exchange row ([D111]) under
        // `/arc-run` — which is what a restore replays too.
        const rows = await shellRowText(app);
        const receipt = rows.find((t) => t.indexOf("you stopped it") !== -1) ?? "";
        note("at0476 stop receipt", receipt);
        // **The header is a parse key, not display text.** The receipt's
        // first line — `arc stopped · <arc> · in <stage> — <reason>` — is
        // what `parseArcReceipt` matches on, and the block's whole purpose is
        // to spend it: it renders the arc as an atom, the reason as the
        // lifecycle strip's note, and the resume sentence as its own line.
        // Asserting the raw prefix would pin the row to *not* having been
        // recognized, which is the opposite of the claim. So the claim is
        // that it was recognized — the wheel-attributed identifier is the one
        // word only the arc-receipt block puts on a row.
        expect(receipt).toContain("Wheel");
        expect(receipt).toContain(ARC_NAME);
        // The receipt says how to pick the work back up — that is the third
        // column of every row of the doctrine table.
        expect(receipt).toContain(`tugtool arc run ${ARC_NAME}`);
        note("at0476 card with the stop receipt", (await app.screenshot()).path);

        // ── And the work is still there ───────────────────────────────────
        //
        // The verb's own `--json` is the reading, not a later look at the log:
        // once the arc is resumed the runner is free to rotate it again, so
        // the record is a moving target and the CLI's statement is not.
        const resumed = JSON.parse(
          tugtool(["arc", "run", ARC_NAME, "--json"], {
            cwd: projectDir(),
            binaryRoot: CHECKOUT,
            env: { ...scratch?.cli.env, TUG_SESSION_ID: SID },
          }),
        ) as { data: { resumed: boolean; arc: { resume: string | null } | null } };
        note("at0476 resume", JSON.stringify(resumed.data));
        expect(resumed.data.resumed).toBe(true);
        expect(resumed.data.arc?.resume).toBe("devise");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a second arc on a card already running one is refused by name",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0476-arc-interruptions-bind",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await openCard(app);

        // One line again, and for the same reason: the refusal is about a
        // card running a **live** arc, and a tick between the two verbs
        // would seat a stage or stop the arc, either of which changes the
        // question being asked.
        await shellAndSettle(
          app,
          `${cli} arc run ${OTHER_ARC} && ${cli} arc bind ${THIRD_ARC}`,
        );

        // ── The interruption that is refused rather than described ────────
        //
        // The message is the whole proof of the binding it protects: the
        // server names what the card is running back to the person who asked
        // to displace it.
        const rows = await shellRowText(app);
        const refusal = rows[0] ?? "";
        note("at0476 bind refusal", refusal);
        expect(refusal).toContain(`card runs ${OTHER_ARC}`);
        expect(refusal).toContain(THIRD_ARC);
        note("at0476 card with the refusal", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0763-join-disabled-while-running.test.ts — Join is refused while a run
 * holds the arc, and says why.
 *
 * One arc admits one run, and the server refuses a join pressed while one
 * holds it. The deck used to judge Join on the outcome alone, so a candidate
 * standing early in a run lit a button whose press could only come back as
 * "a resolve is already running for this arc" — drawn in red, twice. The gate
 * now reads the feed's `join.run`: while it is set, Join is refused with
 * "Wait for the resolve to finish", and a press sends nothing.
 *
 * The run is real. A scratch repository holds one genuine conflict and a
 * resolver stub that reads its charter and then sleeps, so the pilot's run on
 * the built arc stays live for as long as the test needs it. The arc row's
 * Join — the composer's gate through a second door — is read refused with the
 * sentence, then clicked, and the base's log is read to show nothing landed.
 *
 * @covers tugdeck/src/lib/join-mode-controller.ts
 * @covers tugdeck/src/lib/arc-verbs.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindArc,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  silenceJoinPrompt,
  tugtool,
  type JoinScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** Minted per run, for the reason at0683 gives. */
const SID = randomUUID();
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const ARC = "at0763-work";
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC}"]`;
const JOIN = `${ROW} [data-slot="arc-verb"][data-verb="join"]`;
const HINT = "Wait for the resolve to finish";
const DRAFT_MESSAGE = "at0763 join draft\n\nMust not land while the run holds the arc.";

/** Holds the run: the charter is read, and the resolver then simply waits. */
const RESOLVER_STUB = "#!/bin/sh\nread -r _charter\nsleep 120\n";

let scratch: JoinScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";
let fixtureDir = "";
let tugbankPath = "";
let arcId = "";

const instanceChangesDb = (instanceId: string): string =>
  join(scratch?.dataRoot ?? "", "Tug/instances", instanceId, "changes.db");

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeJoinScratchRepo({
    prefix: "at0763",
    arc: ARC,
    description: "at0763 fixture (a run that holds the arc)",
    checkout: CHECKOUT,
    file: "subject.txt",
    fork: "at0763 the body both sides will rewrite\n",
    base: "at0763 base side — the whole file, rewritten\n",
    arcBody: "at0763 arc side — the whole file, rewritten\n",
    resolver: RESOLVER_STUB,
    // `built` hands the arc to the pilot, whose run is the one under test.
    built: true,
  });
  arcId = scratch.arcId;
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmJoinScratchRepo(scratch);
  rmScratchSession(fixtureDir);
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
});

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Open the Changes shade, retried until the lane shows the arc (at0683). */
async function openTheShade(app: App): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    await app.body("A").nativeClickAtElement(EDITOR);
    await settle();
    await app.nativeKey("a", ["cmd"]);
    await app.nativeKey("Delete");
    await app.nativeType("/commit");
    await settle();
    await app.nativeKey("Escape");
    await settle();
    await app.nativeKey("Return", ["cmd"]);
    const attemptBy = Date.now() + 5_000;
    while (Date.now() < attemptBy) {
      if (await app.body("A").evalJS<boolean>(`document.querySelector(${JSON.stringify(ROW)}) !== null`)) return;
      await settle(100);
    }
    note(`at0763 the shade did not show the arc (attempt ${attempt})`);
  }
  throw new Error("at0763: the Changes shade never showed the arc");
}

/** The subject of the base's newest commit. */
function baseSubject(): string {
  const out = Bun.spawnSync(["git", "-C", projectDir(), "log", "-1", "--format=%s"]);
  return new TextDecoder().decode(out.stdout).trim();
}

/** The row Join's refusal facts. */
const JOIN_FACTS = `(() => {
  const el = document.querySelector(${JSON.stringify(JOIN)});
  return el === null
    ? null
    : { refused: el.getAttribute("data-refused"), label: el.getAttribute("aria-label") ?? "" };
})()`;

describe.skipIf(!SHOULD_RUN)("AT0763: Join is refused while a run holds the arc", () => {
  test(
    "a live run disables Join with the wait sentence, and a press lands nothing",
    async () => {
      tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0763-join-disabled-while-running",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        // The pilot works only an arc somebody holds ([D147]).
        bindArc(projectDir(), ARC, SID, scratch?.cli ?? {});
        silenceJoinPrompt(projectDir(), ARC);
        await app.dispatchControlAction("bind_arc_ok", {
          tug_session_id: SID,
          arc_id: arcId,
          arc_name: ARC,
        });
        // A draft of the test's own, so the row's own "no join message"
        // refusal cannot stand in for the gate's.
        tugtool(
          ["draft", "set", "--owner", `arc:${ARC}`, "--message", DRAFT_MESSAGE, "--json"],
          {
            cwd: projectDir(),
            binaryRoot: CHECKOUT,
            env: { ...scratch?.cli.env, TUG_CHANGES_DB: instanceChangesDb(app.instanceId) },
          },
        );
        await openTheShade(app);

        // ── The run holds the arc, and Join says so. ──
        await app.body("A").waitForCondition<boolean>(
          `(${JOIN_FACTS})?.label.includes(${JSON.stringify(HINT)}) === true`,
          { timeoutMs: 60000 },
        );
        const before = await app.body("A").evalJS<{ refused: string | null; label: string }>(JOIN_FACTS);
        note(`at0763 Join under the run: ${JSON.stringify(before)}`);
        expect(before.refused, "Join is refused while the run holds the arc").toBe("true");
        expect(before.label).toContain(HINT);

        // ── A press sends nothing: the base does not move. ──
        const subjectBefore = baseSubject();
        await app.body("A").nativeClickAtElement(JOIN);
        await settle(2000);
        const after = await app.body("A").evalJS<{ refused: string | null; label: string }>(JOIN_FACTS);
        note(`at0763 Join after the press: ${JSON.stringify(after)}`);
        expect(baseSubject(), "the press landed nothing").toBe(subjectBefore);
        expect(after.refused, "Join stays refused while the run holds the arc").toBe("true");
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0763] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

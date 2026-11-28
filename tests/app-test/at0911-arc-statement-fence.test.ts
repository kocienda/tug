/**
 * at0911-arc-statement-fence.test.ts — a `tugarcs` fence in an answer is
 * drawn as the run it declares, each row reading where its arc stands.
 *
 * The fixture is a real cycle in a scratch project, made through the built
 * `tugtool`: entry 1 carried by an arc that has joined, and entry 2 queued for
 * an arc nobody has opened. The session's one answer states three arcs: the
 * joined one, the queued one, and a third that is on no cycle. What is read:
 *
 *   1. The fence draws as one frame of three rows, in the fence's order, and
 *      no JSON is on screen.
 *   2. The joined arc's row reads Landed and offers no command.
 *   3. The queued arc's row reads Ready and offers its command, and a press on
 *      its Copy puts `/arc <name> @<brief>` on the clipboard.
 *   4. The third arc's row reads Not queued: no entry names it and the arc
 *      log has never heard of it.
 *   5. A row's brief is the file atom a backticked path in prose becomes.
 *
 * @covers tugdeck/src/lib/arc-statement.ts
 * @covers tugdeck/src/lib/markdown/enhance-arc-statement.ts
 * @covers tugdeck/src/lib/markdown/enhance-arc-statement.css
 * @covers tugdeck/src/lib/markdown/enhance-fenced-code.ts
 * @covers tugdeck/src/components/tugways/cards/use-arc-statements.ts
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { restoreSettled } from "./overlay-fixture";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtool,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000911";
const LANDED = "at0911-index";
const QUEUED = "at0911-query";
const LOOSE = "at0911-export";
const QUEUED_BRIEF = "briefs/query.md";

const CARD = '[data-card-id="A"]';
const FRAME = `${CARD} .tugx-md-arcs`;

const SPEC = JSON.stringify({
  tugarcs: 1,
  arcs: [
    { name: LANDED, brief: "briefs/index.md", label: "Build the index" },
    { name: QUEUED, brief: QUEUED_BRIEF, label: "Answer queries" },
    { name: LOOSE, brief: "briefs/export.md", label: "CSV export", after: [] },
  ],
});
const REPLY = "The run:\n\n```tugarcs\n" + SPEC + "\n```\n";

/** This checkout — the build under test. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/** Run one `tugtool` verb in the scratch project. */
const run = (args: string[], stdin?: string): string =>
  tugtool(args, {
    cwd: projectDir(),
    binaryRoot: scratch?.cli.binaryRoot,
    env: scratch?.cli.env,
    stdin,
  }).trim();

/** The session's transcript: one question, and the answer holding the fence. */
function transcript(cwd: string): string {
  const base = { isSidechain: false, userType: "external", cwd, sessionId: SID, version: "2.1.105", gitBranch: "main" };
  const rows = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-000000911e01",
      timestamp: new Date(Date.now() - 2000).toISOString(),
      message: { role: "user", content: [{ type: "text", text: "lay out the run" }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000911e01",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000911e02",
      timestamp: new Date(Date.now() - 1000).toISOString(),
      message: {
        id: "msg-arcs-911",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: REPLY }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 8000 },
      },
    },
  ];
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0911",
    checkout: CHECKOUT,
    files: {
      "briefs/index.md": "# Index brief\n\nBuild the index.\n",
      [QUEUED_BRIEF]: "# Query brief\n\nAnswer queries.\n",
      "briefs/export.md": "# Export brief\n\nWrite CSV.\n",
    },
  });
  fixtureDir = seedScratchSession(projectDir(), SID);
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), transcript(projectDir()));

  // Entry 1, carried by an arc that joins; entry 2, queued for an arc nobody opened.
  const arc = createArc(projectDir(), LANDED, "at0911 fixture", scratch.cli);
  writeFileSync(join(arc.worktree, "at0911.txt"), "the arc's one change\n");
  commitRound(projectDir(), LANDED, "at0911(round): add a file", scratch.cli);
  const id = run(["cycle", "create", "--name", "at0911 cycle"]);
  // `sketch record` prints "sketch <id> v1 (minted)"; the id is its second word.
  const recorded = run(["sketch", "record"], "# Sketch\n\nA run of three.\n");
  run(["cycle", "add-sketch", id, recorded.split(/\s+/)[1] ?? ""]);
  run(["cycle", "add-entry", id, "--brief", "briefs/index.md", "--from", "A"]);
  run(["cycle", "attach", id, "1", LANDED]);
  run(["cycle", "queue", QUEUED, "--brief", QUEUED_BRIEF, "--cycle", id, "--from", "A"]);
  run(["arc", "join", LANDED, "--json"]);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

interface RowReading {
  arc: string;
  label: string;
  state: string;
  word: string;
  commandShown: boolean;
  command: string;
  briefAtom: boolean;
}

interface FrameReading {
  frames: number;
  jsonShown: boolean;
  rows: RowReading[];
}

const READ = `(() => {
  const frames = document.querySelectorAll(${JSON.stringify(FRAME)});
  const frame = frames[0];
  const text = (el) => (el?.textContent ?? "").trim();
  const pre = frame?.querySelector(":scope > pre");
  return {
    frames: frames.length,
    jsonShown: pre ? getComputedStyle(pre).display !== "none" : false,
    rows: Array.from(frame?.querySelectorAll(".tugx-md-arcs-row") ?? []).map((row) => {
      const command = row.querySelector(".tugx-md-arcs-command");
      return {
        arc: row.getAttribute("data-arc") ?? "",
        label: text(row.querySelector(".tugx-md-arcs-label")),
        state: row.getAttribute("data-state") ?? "",
        word: text(row.querySelector(".tugx-md-arcs-state")),
        commandShown: command !== null && getComputedStyle(command).display !== "none",
        command: text(command?.querySelector("code")),
        briefAtom: row.querySelector('.tugx-md-arcs-brief [data-tug-annotation="file-path"]') !== null,
      };
    }),
  };
})()`;

describe.skipIf(!SHOULD_RUN)("AT0911: a tugarcs fence draws as the run it declares", () => {
  test(
    "each row reads its arc's place on the cycle, and the queued one's command copies",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0911-arc-statement-fence",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });
        await restoreSettled(app, "A");

        // Every row settled: the cycle has arrived and the arc log has answered.
        await app
          .body("A")
          .waitForCondition<boolean>(
            `(() => {
               const r = ${READ};
               return r.rows.length === 3
                 && r.rows.every((row) => row.word !== "")
                 && r.rows[0].state === "joined"
                 && r.rows[1].state === "ready"
                 && r.rows.every((row) => row.briefAtom);
             })()`,
            { timeoutMs: 30_000 },
          )
          .catch(() => undefined);
        const drawn = await app.body("A").evalJS<FrameReading>(READ);

        expect(drawn.frames, "one frame for the one fence").toBe(1);
        expect(drawn.jsonShown, "the spec itself is not on screen").toBe(false);
        expect(drawn.rows.map((r) => r.arc), "a row per arc, in the fence's order").toEqual([LANDED, QUEUED, LOOSE]);
        expect(drawn.rows.map((r) => r.label)).toEqual(["Build the index", "Answer queries", "CSV export"]);

        const [landed, queued, loose] = drawn.rows;
        expect(landed?.word, "the joined arc has landed").toBe("Landed");
        expect(landed?.commandShown, "a landed arc offers no command").toBe(false);
        expect(queued?.word, "the queued arc is ready to open").toBe("Ready");
        expect(queued?.commandShown, "and offers the command that opens it").toBe(true);
        expect(queued?.command).toBe(`/arc ${QUEUED} @${QUEUED_BRIEF}`);
        expect(loose?.state, "an arc on no cycle that the log has never heard of").toBe("none");
        expect(loose?.word).toBe("Not queued");
        expect(drawn.rows.map((r) => r.briefAtom), "every brief is a ruled file atom").toEqual([true, true, true]);

        // Copy on the queued row: capture the write in the body's page rather
        // than touch the machine's pasteboard.
        await app.body("A").evalJS<boolean>(
          `(() => {
             window.__at0911Copied = null;
             const sink = (text) => { window.__at0911Copied = text; return Promise.resolve(); };
             try { navigator.clipboard.writeText = sink; }
             catch (e) { Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: sink }); }
             return true;
           })()`,
        );
        await app
          .body("A")
          .click(`${FRAME} .tugx-md-arcs-row[data-arc="${QUEUED}"] .tugx-md-arcs-command .tugx-md-chrome-copy`);
        await app
          .body("A")
          .waitForCondition<boolean>(`window.__at0911Copied !== null`, { timeoutMs: 5_000 })
          .catch(() => undefined);
        const copied = await app.body("A").evalJS<string | null>(`window.__at0911Copied`);
        expect(copied, "Copy puts the command on the clipboard").toBe(`/arc ${QUEUED} @${QUEUED_BRIEF}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

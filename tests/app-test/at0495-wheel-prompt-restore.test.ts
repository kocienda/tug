/**
 * at0495-wheel-prompt-restore.test.ts — the Wheel is still the Wheel after a
 * relaunch.
 *
 * ## What this gates
 *
 * The Wheel steers an arc, and the transcript says so: a prompt it sends
 * speaks in a row of its own, under the Wheel's name and mark. Claude's JSONL
 * cannot carry that fact — that file is claude's, and it records a prompt the
 * Wheel sent exactly as it records one the user typed — so on the reload the
 * row would come back reading **You**, and the transcript would change its
 * mind about who was steering purely because the app was relaunched.
 *
 * The fix is that the Wheel keeps its own record of what it put on the wire
 * (`wheel_prompts` in `sessions.db`), and the replay states authorship from
 * that record. This test is what says so from the outside: a fixture JSONL
 * holding one Wheel prompt and one the user typed, a seeded record naming only
 * the first, and a real resume — after which one row is the Wheel's and the
 * other is not.
 *
 * The two prompts are deliberately adjacent turns in ONE file. Nothing about
 * where they sit distinguishes them, which is exactly why the rule this
 * replaced (the first user turn of a stage session) could never have got this
 * right.
 *
 * The Wheel prompt is stored in claude's `<command-*>` envelope, because that
 * is what claude writes for a slash command and every prompt an arc sends is
 * one. The record holds the text as it went out, so the match is made against
 * the envelope put back together — name, then args.
 *
 * @covers tugcode/src/replay.ts
 * @covers tugcode/src/session.ts
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugcast/src/wheel/mod.rs
 * @covers tugrust/crates/tugcast/src/feeds/arc_runner.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SESSION = "c1a0d1ea-0000-4000-8000-000000000495";
const LINE = "c1a0d1ea-0000-4000-8000-000000000496";

/** The prompt the Wheel put on the wire — the raw text, not claude's envelope. */
const WHEEL_COMMAND = "/tugplug:arc-implement";
const WHEEL_ARGS = "demo implement Step 4 and end your turn; Steps 4-13 remain on this run";
const WHEEL_SENT = `${WHEEL_COMMAND} ${WHEEL_ARGS}`;

/** What the user typed, one turn later, in the same session. */
const TYPED = "and here is something I typed myself";

const ENTRY = ".tug-transcript-entry[data-participant]";

const INSTANCE_ID = `${process.env.TUG_APPTEST_ID_PREFIX ?? "apptest"}-wheel-restore-${randomUUID()}`;

let projectDir = "";
let fixtureDir = "";

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

/**
 * Two committed turns: the Wheel's prompt in the envelope claude writes for a
 * slash command, then the user's own words. Nothing in the file says which is
 * which.
 */
function buildFixtureJsonl(cwd: string, sessionId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const uuid = (n: number): string => `00000000-0000-4000-8000-00000000049${n}`;
  const at = (n: number): string => new Date(Date.now() - 600_000 + n * 1000).toISOString();
  const answer = (n: number, parent: string, text: string) => ({
    ...base,
    parentUuid: parent,
    type: "assistant",
    uuid: uuid(n),
    timestamp: at(n),
    message: {
      id: `msg-0495-${n}`,
      type: "message",
      role: "assistant",
      model: "claude-opus-4-8",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1200,
        output_tokens: 50,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 8000,
      },
    },
  });
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: uuid(0),
      timestamp: at(0),
      message: {
        role: "user",
        content:
          `<command-message>${WHEEL_COMMAND.slice(1)}</command-message>\n` +
          `<command-name>${WHEEL_COMMAND}</command-name>\n` +
          `<command-args>${WHEEL_ARGS}</command-args>`,
      },
    },
    answer(1, uuid(0), "on it"),
    {
      ...base,
      parentUuid: uuid(1),
      type: "user",
      uuid: uuid(2),
      timestamp: at(2),
      message: { role: "user", content: [{ type: "text", text: TYPED }] },
    },
    answer(3, uuid(2), "understood"),
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0495-")));
  writeFileSync(join(projectDir, "README.md"), "at0495\n");
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SESSION}.jsonl`), buildFixtureJsonl(projectDir, SESSION));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
  if (fixtureDir !== "" && existsSync(fixtureDir)) {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session A", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
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
    { timeoutMs: 15_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0495 — a restored transcript still names the Wheel", () => {
  test(
    "the prompt the Wheel sent comes back the Wheel's; the one beside it stays the user's",
    async () => {
      // ── Phase A: the ledger state an arc leaves behind. ──
      //
      // Seeded after launch, because `demote_live_to_closed` flips every live
      // row at startup — a row seeded before one would arrive closed.
      {
        const app = await launchTugApp({
          testName: "at0495-wheel-prompt-restore-A",
          instanceId: INSTANCE_ID,
        });
        try {
          await awaitDeck(app);
          app.seedLedger({
            sessions: [
              {
                session_id: SESSION,
                workspace_key: projectDir,
                project_dir: projectDir,
                card_id: "A",
                line_id: LINE,
              },
            ],
            // Only the first prompt. The typed one is deliberately absent —
            // that is the whole distinction under test.
            wheel_prompts: [{ session_id: SESSION, text: WHEEL_SENT }],
          });
        } finally {
          await app.close();
        }
      }

      // ── Phase B: relaunch and resume. The transcript is rebuilt from the
      //    JSONL, and authorship from the record beside it. ──
      const app = await launchTugApp({
        testName: "at0495-wheel-prompt-restore-B",
        instanceId: INSTANCE_ID,
      });
      try {
        await awaitDeck(app);
        await app.spawnSessionResume("A", { tugSessionId: SESSION, projectDir });

        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(
            ENTRY,
          )})).some((el) => (el.textContent || "").includes(${JSON.stringify(TYPED)}))`,
          { timeoutMs: 30_000 },
        );

        const rows = JSON.parse(
          await app.evalJS<string>(
            `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
              ENTRY,
            )})).map((el) => [el.getAttribute("data-participant"), (el.textContent || "").trim()]))`,
          ),
        ) as Array<[string, string]>;

        const wheelRows = rows.filter(([p]) => p === "wheel");
        expect(
          wheelRows.length,
          "the prompt the wheel sent comes back under the wheel's name",
        ).toBe(1);
        expect(wheelRows[0]![1], "and it is the wheel's prompt, not somebody else's").toContain(
          WHEEL_ARGS,
        );

        const typed = rows.filter(([, t]) => t.includes(TYPED));
        expect(typed.length, "the typed message is on screen exactly once").toBe(1);
        expect(
          typed[0]![0],
          "a prompt the record does not hold is the user's, whatever sits above it",
        ).toBe("user");

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0495] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

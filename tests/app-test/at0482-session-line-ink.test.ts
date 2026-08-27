/**
 * at0482-session-line-ink.test.ts — durable ink belongs to the line, so a
 * segment that did not exist when it was written still restores it.
 *
 * ## What this gates
 *
 * `shell_exchanges` rows are keyed by `line_id` ([P09]). A `/commit` receipt,
 * a `$` shell row, a join receipt — the user's acts, which live outside the
 * conversation's context — are written under the line the card is on, and read
 * back under the same line however many claude ids the card has worn since.
 *
 * This is at0462's question asked of the model that replaces the adoption
 * apparatus. There is no adoption pass any more, and nothing walks an edge at
 * read time: the write and the read both resolve the seated segment to its
 * line and use that as the key, which is why the answer cannot depend on a
 * boot pass having run.
 *
 * The shape, as at0462's:
 *
 *   1. **The ink is organic** — written by the real `$` route through the real
 *      ledger. There is no shell-exchange seeding and there should not be.
 *   2. **The next segment is seeded** — a real rotation needs a live `claude`.
 *   3. **A full process relaunch**, so both phases share one
 *      `shell_exchanges.db`.
 *   4. **Truth read from the STORES** — a windowed transcript can paint zero
 *      rows while the store holds all of them.
 *
 * @covers tugrust/crates/tugcast/src/shell_ledger.rs
 * @covers tugrust/crates/tugcast/src/ink_backfill.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugdeck/src/lib/shell-session-store.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const LINE = "c1a0d1ea-0000-4000-8000-0000000004a0";
/** The segment the ink is written on. */
const SEATED = "c1a0d1ea-0000-4000-8000-0000000004a1";
/** The segment the card rotates into afterwards — the relaunch's resume target. */
const NEXT = "c1a0d1ea-0000-4000-8000-0000000004a2";

const INSTANCE_ID = `${process.env.TUG_APPTEST_ID_PREFIX ?? "apptest"}-line-ink-${randomUUID()}`;

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const COMMANDS = ["echo line-ink-one", "echo line-ink-two"] as const;

interface InkFacts {
  shellTurns: number;
  commands: string[];
  restore: {
    ledgerTotal: number;
    applied: number;
    complete: boolean;
    answered: boolean;
  };
}

let projectDir = "";
let fixtureDir = "";

const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

function buildFixtureJsonl(cwd: string, sessionId: string): string {
  const t0 = new Date(Date.now() - 600_000).toISOString();
  const t1 = new Date(Date.now() - 599_000).toISOString();
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const head = `00000000-0000-4000-8000-0000000${sessionId.slice(-5)}`;
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: head,
      timestamp: t0,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      ...base,
      parentUuid: head,
      type: "assistant",
      uuid: `00000000-0000-4000-8000-0000001${sessionId.slice(-5)}`,
      timestamp: t1,
      message: {
        id: `msg-${sessionId.slice(-6)}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "hi there" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1200,
          output_tokens: 50,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 8000,
        },
      },
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0482-")));
  writeFileSync(join(projectDir, "README.md"), "at0482\n");
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  for (const id of [SEATED, NEXT]) {
    writeFileSync(join(fixtureDir, `${id}.jsonl`), buildFixtureJsonl(projectDir, id));
  }
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

async function inkFacts(app: App): Promise<InkFacts> {
  return app.evalJS<InkFacts>(`window.__tug.inkRestoreFacts("A")`);
}

/** Submit one `/shell <cmd>` and block until its row settles with an exit. */
async function execAndSettle(app: App, cmd: string, expectedIndex: number): Promise<void> {
  await app.nativeClickAtElement(PROMPT);
  await app.nativeType(`/shell ${cmd}`);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
  await app.waitForCondition<boolean>(
    `(function(){
      var rows = document.querySelectorAll(${JSON.stringify(SHELL_ROWS)});
      if (rows.length !== ${expectedIndex + 1}) return false;
      var foot = rows[${expectedIndex}].querySelector('[data-slot="session-z1b-end-state"]');
      return foot !== null && foot.textContent.indexOf("exit") !== -1;
    })()`,
    { timeoutMs: 20_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0482 — ink is keyed by the line of work", () => {
  test(
    "ink written on one segment restores onto the segment the card rotates into",
    async () => {
      // ── Phase A: write the line and the segment the ink will be written
      //    on. ──
      //
      // The seed runs the bundle's own `tugcast --seed-ledger`; the deck's
      // restore has already run at connect, so nothing binds here. The line
      // has to exist before the first exec — the ink write resolves the
      // seated segment to its line ([P09]), and a session the ledger has
      // never heard of keys its rows under its own id instead.
      {
        const app = await launchTugApp({
          testName: "at0482-session-line-ink-A",
          instanceId: INSTANCE_ID,
        });
        try {
          await awaitDeck(app);
          app.seedLedger({
            sessions: [
              {
                session_id: SEATED,
                workspace_key: projectDir,
                project_dir: projectDir,
                card_id: "A",
                line_id: LINE,
                tag: "stout-heron",
              },
            ],
          });
        } finally {
          await app.close();
        }
      }

      // ── Phase B: write ink on the seated segment. ──
      {
        const app = await launchTugApp({
          testName: "at0482-session-line-ink-B",
          instanceId: INSTANCE_ID,
        });
        try {
          await app.enableDeckTrace(true);
          await awaitDeck(app);
          await app.bindSession("A", {
            tugSessionId: SEATED,
            lineId: LINE,
            projectDir,
          });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          for (const [i, cmd] of COMMANDS.entries()) {
            await execAndSettle(app, cmd, i);
          }
          const live = await inkFacts(app);
          expect(live.shellTurns, "every exec settled an ink turn").toBe(COMMANDS.length);

          // The card's next claude id, joining the same line.
          app.seedLedger({
            sessions: [
              {
                session_id: NEXT,
                workspace_key: projectDir,
                project_dir: projectDir,
                card_id: "A",
                line_id: LINE,
                forked_from_session_id: SEATED,
                stage_label: "implement",
              },
            ],
          });
        } finally {
          await app.close();
        }
      }

      // ── Phase C: relaunch. The card resumes the new segment and asks for
      //    ink under it. ──
      {
        const app = await launchTugApp({
          testName: "at0482-session-line-ink-C",
          instanceId: INSTANCE_ID,
        });
        try {
          await app.enableDeckTrace(true);
          await awaitDeck(app);
          await app.bindSession("A", {
            tugSessionId: NEXT,
            lineId: LINE,
            projectDir,
          });
          await app.waitForCondition<boolean>(
            `(function(){
               if (typeof window.__tug === "undefined") return false;
               try {
                 var f = window.__tug.inkRestoreFacts("A");
                 return f.restore.answered && f.shellTurns === ${COMMANDS.length};
               } catch (e) { return false; }
             })()`,
            { timeoutMs: 30_000 },
          );

          const restored = await inkFacts(app);
          const facts = await app.evalJS<{ tugSessionId: string; lineId: string }>(
            `window.__tug.cardLineFacts("A")`,
          );
          expect(facts.lineId, "one line").toBe(LINE);
          expect(
            facts.tugSessionId,
            "the card came back on the segment the ink was NOT written on",
          ).toBe(NEXT);

          expect(
            restored.shellTurns,
            "ink written on an earlier segment must survive the rotation",
          ).toBe(COMMANDS.length);
          expect(restored.commands).toEqual([...COMMANDS]);
          // `{ledgerTotal: 0, applied: 0, complete: true}` is the shape a
          // segment-keyed read produces: a settled, confident, wrong answer.
          expect(restored.restore.answered).toBe(true);
          expect(restored.restore.complete).toBe(true);
          expect(restored.restore.ledgerTotal).toBe(COMMANDS.length);
          expect(restored.restore.applied).toBe(COMMANDS.length);
        } finally {
          await app.close();
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0462-ink-fork-restore.test.ts — a forked line of work keeps its receipts
 * across a relaunch.
 *
 * The regression this exists for, reported five times: a `/arc-join` (or any
 * rewind-fork) makes tugcode restart Claude under a **forked** session id, and
 * the sessions ledger records that fork as another **segment** of the card's
 * line. The durable ink — the `/commit` and join receipts that live only in
 * `shell_exchanges.db`, because they are the user's act rather than session
 * context — is keyed by the **line** ([P09]), so a read issued under any
 * segment finds the whole conversation's rows. In the model this replaced, the
 * ink stayed keyed under the parent while the relaunched card asked for the
 * fork's id, and the server truthfully answered `total: 0`. Every safeguard
 * from the at0461 incident worked exactly as designed: they defend against a
 * lost answer, not against a well-formed answer to the wrong question.
 *
 * The shape of the test follows from what an app-test can and cannot drive:
 *
 *   1. **The ink is organic.** There is no shell-exchange seeding, and there
 *      should not be — the rows are written by the real `$` route through the
 *      real ledger, so the fixture is the production write path.
 *   2. **The fork is seeded, not performed.** A real rewind-fork needs a live
 *      `claude` to announce one; the arc itself is covered at the Rust layer.
 *      What a relaunch actually reads is the ledger state a fork leaves
 *      behind — two rows on one `line_id`, joined by `forked_from_session_id`
 *      — and that is exactly what the seed writes.
 *   3. **A full process relaunch, not a deck reload.** Adoption happens when
 *      tugcast opens its ledgers, so the two phases share one `instanceId` —
 *      which is what makes them share one `shell_exchanges.db`.
 *   4. **Truth read from the STORES, not the DOM** (the at0461 doctrine): a
 *      windowed, virtualized transcript can paint zero rows while the store
 *      holds all of them, and can paint zero while it holds none.
 *
 * @covers tugrust/crates/tugcast/src/ink_backfill.rs
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugdeck/src/lib/shell-session-store.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** The line of work both ids below are segments of ([P01]). */
const LINE = "b7c0d1ea-0000-4000-8000-000000000461";
/** The line of work before the fork — where the ink is written. */
const ANCESTOR = "b7c0d1ea-0000-4000-8000-000000000462";
/** The line of work after it — where a relaunched card binds. */
const FORK = "b7c0d1ea-0000-4000-8000-000000000463";

/**
 * One instance id across both launches, so the two share a per-instance
 * `shell_exchanges.db` and `sessions.db`. The prefix must stay in the
 * app-test family: `--seed-ledger` refuses to touch a real ledger, and the
 * recipe's teardown sweeps by prefix.
 */
const INSTANCE_ID = `${process.env.TUG_APPTEST_ID_PREFIX ?? "apptest"}-ink-fork-${randomUUID()}`;

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const COMMANDS = ["echo fork-ink-one", "echo fork-ink-two", "echo fork-ink-three"] as const;

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

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

/**
 * One committed Claude turn, timestamped before the live shell execs so the
 * replayed turn sorts ahead of every ledger-restored exchange.
 *
 * `ownerId` is the id the turns wear. A fork's JSONL is a file copy, so its
 * pre-fork turns keep the ancestor's id — writing the fixture that way keeps
 * it honest about what is on disk after a real fork.
 */
function buildFixtureJsonl(cwd: string, sessionId: string, ownerId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId: ownerId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const t0 = new Date(Date.now() - 600_000).toISOString();
  const t1 = new Date(Date.now() - 599_000).toISOString();
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: `00000000-0000-4000-8000-0000000${sessionId.slice(-5)}`,
      timestamp: t0,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      ...base,
      parentUuid: `00000000-0000-4000-8000-0000000${sessionId.slice(-5)}`,
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
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0462-")));
  writeFileSync(join(projectDir, "README.md"), "at0462\n");
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${ANCESTOR}.jsonl`), buildFixtureJsonl(projectDir, ANCESTOR, ANCESTOR));
  // The fork's file copy: its pre-fork turns still wear the ancestor's id.
  writeFileSync(join(fixtureDir, `${FORK}.jsonl`), buildFixtureJsonl(projectDir, FORK, ANCESTOR));
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

async function inkFacts(app: App): Promise<InkFacts> {
  return app.evalJS<InkFacts>(`window.__tug.inkRestoreFacts("A")`);
}

async function awaitDeck(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
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

describe.skipIf(!SHOULD_RUN)("AT0462: a fork keeps its line of work's receipts", () => {
  test(
    "ink written before a fork comes back when the relaunched card binds to the fork",
    async () => {
      // ── Phase A: write ink under the ancestor, then leave the ledger in
      //    the state a rewind-fork leaves behind. ──
      {
        const app = await launchTugApp({
          testName: "at0462-ink-fork-restore-A",
          instanceId: INSTANCE_ID,
        });
        try {
          await app.enableDeckTrace(true);
          await awaitDeck(app);
          // The ancestor's row, and the line it is a segment of. The ink
          // write resolves the seated segment to its line ([P09]), so the row
          // has to exist before the first exec — a session the ledger has
          // never heard of keys its rows under its own id instead.
          app.seedLedger({
            sessions: [
              {
                session_id: ANCESTOR,
                workspace_key: projectDir,
                project_dir: projectDir,
                card_id: "A",
                line_id: LINE,
              },
            ],
          });
          await app.bindSession("A", { tugSessionId: ANCESTOR, projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          for (const [i, cmd] of COMMANDS.entries()) {
            await execAndSettle(app, cmd, i);
          }
          const live = await inkFacts(app);
          expect(live.shellTurns, "every exec settled an ink turn").toBe(COMMANDS.length);

          // The fork's row — another segment of the same line, wearing the
          // edge a rewind-fork writes. Seeded after launch on purpose:
          // `demote_live_to_closed` flips every live row at startup, so a row
          // seeded before one would arrive closed.
          app.seedLedger({
            sessions: [
              {
                session_id: FORK,
                workspace_key: projectDir,
                project_dir: projectDir,
                card_id: "A",
                line_id: LINE,
                forked_from_session_id: ANCESTOR,
                fork_point: "00000000-0000-4000-8000-00000000f462",
              },
            ],
          });
        } finally {
          await app.close();
        }
      }

      // ── Phase B: a full relaunch onto the fork. ──
      {
        const app = await launchTugApp({
          testName: "at0462-ink-fork-restore-B",
          instanceId: INSTANCE_ID,
        });
        try {
          await app.enableDeckTrace(true);
          await awaitDeck(app);
          await app.spawnSessionResume("A", { tugSessionId: FORK, projectDir });

          // Poll the STORE, not the DOM — the bug's whole signature was a
          // clean, shorter transcript with nothing to notice.
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

          // 1. The receipts of the line of work are on the line's head.
          expect(
            restored.shellTurns,
            "ink written before a fork must survive the relaunch that binds to the fork",
          ).toBe(COMMANDS.length);
          expect(restored.commands).toEqual([...COMMANDS]);

          // 2. And the restore knows the answer is whole. `{ledgerTotal: 0,
          //    applied: 0, complete: true}` is precisely what the broken
          //    build reported: a settled, confident, wrong answer.
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

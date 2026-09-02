/**
 * at0473-ink-anchor-order.test.ts — a receipt comes back where it was written.
 *
 * The sixth vanished-receipt incident was the first in which nothing was
 * actually lost. The `/arc-join` receipt was in the ledger under the exact id
 * the deck resumes, the restore census read complete, and the row was painted
 * in the DOM — five thousand pixels above the transcript's end, behind the
 * final assistant turn. The user, landed at the bottom, saw nothing.
 *
 * The cause was ordering, not identity or completeness. The committed
 * transcript sorts on `messages[0].createdAt`, and a replayed assistant-opened
 * turn used to mint that value as `Date.now()` — the relaunch clock. Every ink
 * row written before the relaunch therefore sorted ahead of a turn it actually
 * followed, and the tall report between them did the rest.
 *
 * Both repairs are pinned here, because either alone would leave a hole:
 *
 *   1. **The written anchor.** Each ledger row records the transcript turn it
 *      followed, stamped server-side at the write gateway, and restore seats
 *      the row after that turn instead of re-deriving a position from clocks.
 *   2. **Honest replay time.** `content_block_start` now carries the JSONL
 *      entry's own timestamp, so no transcript entry wears a fabricated time
 *      and even the fallback path orders correctly.
 *
 * Shape, following at0462's doctrine:
 *
 *   - **The ink is organic** — rows are written by the real `$` route through
 *     the real ledger, so the fixture is the production write path.
 *   - **A full process relaunch**, both phases sharing one `instanceId`, which
 *     is what makes them share one `shell_exchanges.db`.
 *   - **Truth read from the STORES.** A windowed, virtualized transcript can
 *     paint a clean, plausible view while holding the rows in the wrong order
 *     — which is exactly what the incident looked like.
 *
 * The fixture's last turn is deliberately **assistant-opened** (a wake /
 * continuation with no user entry of its own). That is the incident's shape
 * and the one that bites: a user-opened turn's `messages[0]` is its user
 * message, which always carried an honest `submitAt`.
 *
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugcode/src/replay.ts
 * @covers tugrust/crates/tugcast/src/shell_ledger.rs
 * @covers tugrust/crates/tugcast/src/refs_ledger.rs
 * @covers tugrust/crates/tugcast/src/session_ledger.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SESSION = "c8d1e2fb-0000-4000-8000-000000000473";

/** The assistant message id of the fixture's final turn — the anchor to be. */
const LAST_MSG_ID = "msg_at0473_wake";

/**
 * One instance id across both launches, so the two share a per-instance
 * `shell_exchanges.db` and `sessions.db`. The prefix must stay in the
 * app-test family: `--seed-ledger` refuses to touch a real ledger, and the
 * recipe's teardown sweeps by prefix.
 */
const INSTANCE_ID = `${process.env.TUG_APPTEST_ID_PREFIX ?? "apptest"}-ink-anchor-${randomUUID()}`;

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

const COMMANDS = ["echo anchor-ink-one", "echo anchor-ink-two"] as const;

interface OrderEntry {
  origin: string;
  command: string | null;
  anchorMsgId: string | null;
  msgId: string;
  createdAt: number;
  endedAt: number;
}

interface InkFacts {
  shellTurns: number;
  commands: string[];
  restore: {
    ledgerTotal: number;
    applied: number;
    complete: boolean;
    answered: boolean;
  };
  order: OrderEntry[];
}

let projectDir = "";
let fixtureDir = "";

/** Mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string => absDir.replace(/[^A-Za-z0-9-]/g, "-");

/**
 * A transcript ending in an assistant-opened turn.
 *
 * Entry 1/2 are an ordinary user→assistant exchange. Entry 3 is a further
 * assistant entry under a new `message.id` with no user entry of its own — the
 * wake / continuation shape, which replay opens as an assistant-origin turn.
 * Its first Message is the one `content_block_start` mints, so its `createdAt`
 * is the value the whole ordering question turns on.
 *
 * Every timestamp is historical (ten minutes back), so a correctly-ordered
 * restore puts these turns *before* ink that settles during the test.
 */
function buildFixtureJsonl(cwd: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId: SESSION,
    version: "2.1.105",
    gitBranch: "main",
  };
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000).toISOString();
  const usage = {
    input_tokens: 1200,
    output_tokens: 50,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 8000,
  };
  const assistant = (id: string, text: string) => ({
    id,
    type: "message",
    role: "assistant",
    model: "claude-opus-4-8",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  });

  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-000000047301",
      timestamp: at(600),
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000047301",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000047302",
      timestamp: at(599),
      message: assistant("msg_at0473_first", "hi there"),
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000047302",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000047303",
      timestamp: at(598),
      message: assistant(LAST_MSG_ID, "and one more thing"),
    },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0473-")));
  writeFileSync(join(projectDir, "README.md"), "at0473\n");
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SESSION}.jsonl`), buildFixtureJsonl(projectDir));
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

describe.skipIf(!SHOULD_RUN)("AT0473: restored ink seats where it was written", () => {
  test(
    "ink written after the last turn is still the transcript's tail after a relaunch",
    async () => {
      // ── Phase A: replay the fixture, then write ink after its last turn. ──
      {
        const app = await launchTugApp({
          testName: "at0473-ink-anchor-order-A",
          instanceId: INSTANCE_ID,
        });
        try {
          await app.enableDeckTrace(true);
          await awaitDeck(app);
          await app.bindSession("A", { tugSessionId: SESSION, projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          for (const [i, cmd] of COMMANDS.entries()) {
            await execAndSettle(app, cmd, i);
          }

          const live = await inkFacts(app);
          expect(live.shellTurns, "every exec settled an ink turn").toBe(COMMANDS.length);
          // Live ink appends at the end, which is where it belongs at the
          // moment of the act ([P06]) — and the position the relaunch must
          // reproduce.
          expect(
            live.order.slice(-COMMANDS.length).map((e) => e.command),
            "the live rows are the transcript's tail",
          ).toEqual([...COMMANDS]);
        } finally {
          await app.close();
        }
      }

      // ── Phase B: a full relaunch. The rows come back from the ledger. ──
      {
        const app = await launchTugApp({
          testName: "at0473-ink-anchor-order-B",
          instanceId: INSTANCE_ID,
        });
        try {
          await app.enableDeckTrace(true);
          await awaitDeck(app);
          await app.spawnSessionResume("A", { tugSessionId: SESSION, projectDir });

          // Poll the STORE: the restore must be settled AND the replay must
          // have landed its turns, or the ordering question is premature.
          await app.waitForCondition<boolean>(
            `(function(){
               if (typeof window.__tug === "undefined") return false;
               try {
                 var f = window.__tug.inkRestoreFacts("A");
                 return f.restore.answered
                   && f.shellTurns === ${COMMANDS.length}
                   && f.order.some(function(e){ return e.origin !== "shell"; });
               } catch (e) { return false; }
             })()`,
            { timeoutMs: 30_000 },
          );

          const restored = await inkFacts(app);
          const claude = restored.order.filter((e) => e.origin !== "shell");
          const tail = restored.order.slice(-COMMANDS.length);

          // 1. The rows survived, whole — the [D155] / census guarantees.
          expect(restored.shellTurns).toBe(COMMANDS.length);
          expect(restored.restore.answered).toBe(true);
          expect(restored.restore.complete).toBe(true);

          // 2. Each row records the turn it followed. Without the stamp there
          //    is nothing to place it by, and placement falls back to clocks.
          expect(
            tail.map((e) => e.anchorMsgId),
            "every restored row carries the fixture's last assistant message id",
          ).toEqual(COMMANDS.map(() => LAST_MSG_ID));

          // 3. THE ASSERTION. The rows are the transcript's final entries, in
          //    ledger order — exactly where the user watched them land in
          //    phase A. The incident's signature is this list coming back with
          //    the ink somewhere in the middle.
          expect(
            tail.map((e) => e.command),
            "restored ink seats after the turn it was written after",
          ).toEqual([...COMMANDS]);
          expect(
            restored.order.findIndex((e) => e.origin === "shell"),
            "no Claude turn sorts after the ink",
          ).toBe(restored.order.length - COMMANDS.length);

          // 4. And no replayed turn wears a fabricated time. This is the
          //    independent half: it fixes even a legacy row with no anchor,
          //    and it is what the fallback path's honesty rests on.
          for (const entry of claude) {
            expect(
              entry.createdAt,
              `turn ${entry.msgId} opened after it ended — a minted relaunch clock`,
            ).toBeLessThanOrEqual(entry.endedAt);
          }
        } finally {
          await app.close();
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});

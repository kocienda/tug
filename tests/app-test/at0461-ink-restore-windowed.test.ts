/**
 * at0461-ink-restore-windowed.test.ts — ledgered ink survives a relaunch
 * whose Claude replay is windowed ([P07]).
 *
 * The regression this exists for: a `/commit` receipt is the user's act, not
 * session context, so it lives ONLY in `shell_exchanges.db` — no JSONL replay
 * can reconstruct it. On 2026-08-21 two cards came back from an app relaunch
 * holding **0 of 49** ledgered rows, three separate times, and every instrument
 * involved said nothing: the fetch gave up after ~8s into a dev log a release
 * build exposes no handle onto, the server logged the read not at all, and the
 * card rendered a clean shorter transcript with no gap to notice.
 *
 * at0216 already covers Maker ▸ Reload with four rows and a two-turn fixture,
 * and it stayed green throughout — because with a transcript that short the
 * replay window never engages and the restore is answered before anything can
 * race it. This test is deliberately the shape at0216 is not:
 *
 *   1. **More ink rows than the window has turns.** The JSONL fixture carries
 *      one Claude turn and the session carries several shell exchanges, with
 *      the resume asking for a window narrower than the session's history —
 *      so "the rows the turns replayed" and "the rows the ledger holds" are
 *      genuinely different sets.
 *   2. **Truth read from the STORES, not the DOM.** The transcript is
 *      windowed and virtualized, so counting painted rows answers "what is on
 *      screen" — a question that can be green while the store is empty. The
 *      assertions go through `__tug.inkRestoreFacts`, which reads the
 *      committed transcript and the restore census directly.
 *   3. **The completeness census is asserted, not just the count.** A restore
 *      that holds every row *and knows it does* is the contract; a short
 *      answer must report `complete: false` rather than settle quietly.
 *
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugdeck/src/lib/ledger-restore-fetch.ts
 * @covers tugrust/crates/tugcast/src/shell_ledger.rs
 * @covers tugdeck/src/components/tugways/cards/session-load-control-bar.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** UUID-shaped so the real `claude --resume` accepts the fixture JSONL. */
const SID = "a7c0d1ea-0000-4000-8000-000000000461";

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

/** The shell lines this session runs, in order. More than the fixture's turns. */
const COMMANDS = [
  "echo ink-one",
  "echo ink-two",
  "echo ink-three",
  "echo ink-four",
  "echo ink-five",
] as const;

/** What the store-truth seam hands back. */
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
 * One committed Claude turn, timestamped well BEFORE the live shell execs so
 * the replayed turn sorts ahead of every ledger-restored exchange. Carries
 * claude's own session-JSONL fields — a thin fixture reverts the card to the
 * picker via `resume_failed`.
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
  const t0 = new Date(Date.now() - 600_000).toISOString();
  const t1 = new Date(Date.now() - 599_000).toISOString();
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000f01",
      timestamp: t0,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000000f01",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000f02",
      timestamp: t1,
      message: {
        id: "msg-ink-1",
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
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0461-")));
  writeFileSync(join(projectDir, "README.md"), "at0461\n");
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, `${SID}.jsonl`), buildFixtureJsonl(projectDir, SID));
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

/** Ink truth from the stores — never the DOM; see the file docblock. */
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

describe.skipIf(!SHOULD_RUN)(
  "AT0461: ledgered ink survives a windowed replay",
  () => {
    test(
      "every ledgered shell row returns after a reload, and the restore knows it is complete",
      async () => {
        const app = await launchTugApp({ testName: "at0461-ink-restore-windowed" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 15_000 },
          );
          await app.bindSession("A", { tugSessionId: SID, projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          // --- Write more ink than the fixture has Claude turns. ---
          for (const [i, cmd] of COMMANDS.entries()) {
            await execAndSettle(app, cmd, i);
          }

          const live = await inkFacts(app);
          expect(live.shellTurns, "every exec settled an ink turn").toBe(COMMANDS.length);

          // --- Reload → real resume replay + ledger restore. ---
          await app.appReload();
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 15_000 },
          );
          await app.spawnSessionResume("A", { tugSessionId: SID, projectDir });

          // Poll the STORE, not the DOM: a windowed transcript can paint zero
          // ink rows while the store holds all of them, and — the actual
          // 2026-08-21 failure — can paint zero while the store holds none.
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

          // 1. Every ledgered row is back — the whole point.
          expect(
            restored.shellTurns,
            "every ledgered ink row must return after a reload ([P07])",
          ).toBe(COMMANDS.length);
          expect(restored.commands).toEqual([...COMMANDS]);

          // 2. And the restore KNOWS it is complete. A restore that holds the
          //    rows by luck but cannot tell a full answer from a short one is
          //    the same bug waiting for a slower boot.
          expect(restored.restore.answered).toBe(true);
          expect(
            restored.restore.complete,
            "a full answer must report complete, so a short one can report otherwise",
          ).toBe(true);
          expect(restored.restore.ledgerTotal).toBe(COMMANDS.length);
          expect(restored.restore.applied).toBe(COMMANDS.length);

          // 3. No gap notice when nothing is missing — the affordance must be
          //    silent in the healthy case or it is noise, not a signal.
          const gapNotices = await app.evalJS<number>(
            `document.querySelectorAll('[data-slot="session-transcript-ink-gap"]').length`,
          );
          expect(gapNotices, "a complete restore shows no gap notice").toBe(0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

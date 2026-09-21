/**
 * at0216-shell-exchange.test.ts — the `/shell` command end-to-end + restore
 * interleave ([P07], Risk R02).
 *
 * Drives the REAL shell backend: a `/shell <cmd>` submission sends
 * SHELL_INPUT over the live connection, tugcast's per-session shell child
 * executes the command, and the SHELL_OUTPUT frames thread a settled
 * exchange row into the transcript as non-context ink ([P11]).
 *
 *   1. **Exchange e2e** — `echo` / `cd` / `pwd` submitted through the real
 *      prompt entry each settle a transcript row carrying the command, the
 *      combined output, and the exit label; the `cd` followed by `pwd`
 *      proves the shell session is stateful across exchanges. A final
 *      `echo "$TUG_SESSION_ID"` proves the shell child inherits the card's
 *      session id (parity with the agent bridge's env export) — the value
 *      `tugtool changes` reads.
 *      `/shell` is the deliberate override; a bare command line reaches the
 *      shell through the auto-router (`shell-line-classifier`), which is
 *      at0433's.
 *   2. **Non-context styling hook** — every shell row renders inside
 *      `[data-slot="session-transcript-shell-row"]` with
 *      `[data-participant="shell"]` on its transcript entry (the [P11]
 *      visual-distinctness anchor).
 *   3. **Restore interleave ([P07])** — after Maker ▸ Reload, a real
 *      `spawn_session(resume)` replays a fixture JSONL Claude turn while
 *      the ledgered shell exchanges restore through `list_shell_exchanges`;
 *      the fixture's timestamps predate the live execs, so the reloaded
 *      transcript must reproduce the identical row order and shell row
 *      content regardless of arrival order.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugdeck/src/lib/ledger-restore-fetch.ts
 * @covers tugdeck/src/lib/shell-line-classifier.ts
 * @covers tugdeck/src/lib/shell-share.ts
 * @covers tugrust/crates/tugcast/src/feeds/shell.rs
 * @covers tugrust/crates/tugcast/src/shell_ledger.rs
 * @covers tugdeck/src/components/tugways/blocks/block-header.css
 * @covers tugdeck/src/components/tugways/blocks/block-header.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/terminal-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-z1b.tsx
 * @covers tugdeck/src/components/tugways/tug-transcript-entry.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

// UUID-shaped so the reload half's real `claude --resume` accepts it.
const SID = "a7c0d1ea-0000-4000-8000-000000000216";
const FEED_CODE_OUTPUT = 0x40;

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;
const ENTRIES = `${CARD} [data-slot="tug-transcript-entry"]`;

/** Encode a project dir the way claude names its per-project subdir —
 *  mirrors tugcode's `encodeProjectDir` (see at0192 for the rationale). */
const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

/**
 * One clean Claude turn ("hello" → "hi there"), timestamped at fixture-
 * build time — BEFORE any live shell exec — so the replayed turn must
 * sort ahead of the ledger-restored exchanges on reload. Carries claude's
 * own session-JSONL fields so a real `claude --resume` accepts the file
 * (a thin fixture reverts the card to the picker via `resume_failed`).
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
  const t0 = new Date(Date.now() - 2000).toISOString();
  const t1 = new Date(Date.now() - 1000).toISOString();
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000e01",
      timestamp: t0,
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000000e01",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000e02",
      timestamp: t1,
      message: {
        id: "msg-shell-1",
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
  return lines.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

let projectDir = "";
let fixtureDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // realpath: tugcode/claude resolve `/var` → `/private/var` before encoding
  // the claude-projects subdir, and the shell's `pwd` prints the resolved
  // path — encode + exec against the SAME string.
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0216-proj-")));
  mkdirSync(join(projectDir, "sub"));
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

/** The transcript's participant sequence, in document order. */
async function participantOrder(app: App): Promise<string[]> {
  return app.evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(ENTRIES)}))
       .map(function(el){ return el.getAttribute("data-participant") || ""; })`,
  );
}

/** Per-shell-row facts: command text (in the block header), terminal output
 *  text, and the Z1B end-state label (exit badge + duration). */
async function shellRowFacts(
  app: App,
): Promise<Array<{ command: string; output: string; footer: string }>> {
  return app.evalJS<Array<{ command: string; output: string; footer: string }>>(
    `Array.from(document.querySelectorAll(${JSON.stringify(SHELL_ROWS)})).map(function(row){
       var cmd = row.querySelector(".shell-exchange-command-text");
       var out = row.querySelector(".tugx-term-content");
       var foot = row.querySelector('[data-slot="session-z1b-end-state"]');
       return {
         command: cmd ? cmd.textContent.trim() : "",
         output: out ? out.textContent : "",
         footer: foot ? foot.textContent : "",
       };
     })`,
  );
}

/** Submit `line` — a `/shell <cmd>` command — through the real prompt
 *  entry, and block until shell row
 *  `expectedIndex` (0-based) settles with an exit label. The first exec also
 *  spawns the login-shell child, so the wait is generous. */
async function execAndSettle(
  app: App,
  line: string,
  expectedIndex: number,
): Promise<void> {
  await app.nativeClickAtElement(PROMPT);
  await app.nativeType(line);
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
  "AT0216: /shell — exchange e2e, statefulness, restore interleave",
  () => {
    test(
      "echo/cd/pwd settle real exchange rows; reload reproduces the interleaved order",
      async () => {
        const app = await launchTugApp({ testName: "at0216-shell-exchange" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A", { tugSessionId: SID, projectDir });
          await app.awaitEngineReady("A");

          // --- A committed Claude turn, mirroring the reload fixture. ---
          await app.driveSession("A", { op: "send", text: "hello" });
          const frame = (decoded: Record<string, unknown>) =>
            app.driveSession("A", {
              op: "ingestFrame",
              feedId: FEED_CODE_OUTPUT,
              decoded: { tug_session_id: SID, ...decoded },
            });
          await frame({ type: "prompt_anchor", promptUuid: "uuid-1" });
          await frame({
            type: "content_block_start",
            msg_id: "m1",
            block_index: 0,
            kind: "text",
          });
          await frame({
            type: "assistant_text",
            msg_id: "m1",
            block_index: 0,
            text: "hi there",
            is_partial: false,
          });
          await frame({ type: "turn_complete", msg_id: "m1", result: "success" });

          // --- Four real exchanges through the live shell backend. The last
          // reads $TUG_SESSION_ID,
          // which the shell child must inherit from the card (parity with the
          // agent bridge) so `tugtool changes` run from here resolves the
          // session against the ledger. ---
          await execAndSettle(app, "/shell echo hello-from-shell", 0);
          await execAndSettle(app, "/shell cd sub", 1);
          await execAndSettle(app, "/shell pwd", 2);
          await execAndSettle(app, '/shell echo "sid=$TUG_SESSION_ID"', 3);

          // Row facts: command, real output, exit label. The row carries the
          // routed payload — the `/shell` sigil never reaches the shell.
          const live = await shellRowFacts(app);
          expect(live.length).toBe(4);
          expect(live[0].command).toBe("echo hello-from-shell");
          expect(live[0].output).toContain("hello-from-shell");
          expect(live[0].footer).toContain("exit 0");
          expect(live[1].command).toBe("cd sub");
          expect(live[1].footer).toContain("exit 0");
          // The `cd` moved the shell child's cwd — the escape-hatch `pwd`
          // prints the new one, proving the session is stateful across
          // exchanges.
          expect(live[2].command).toBe("pwd");
          expect(live[2].output).toContain(join(projectDir, "sub"));
          expect(live[2].footer).toContain("exit 0");
          expect(live[3].command).toBe('echo "sid=$TUG_SESSION_ID"');
          expect(live[3].output).toContain(`sid=${SID}`);
          expect(live[3].footer).toContain("exit 0");

          // The block wears the standard tool-block header chevron, and it
          // collapses the output. The first disclosure in the card belongs to
          // the first shell row (the `hello` Claude turn ran no tools): a
          // click unmounts its terminal body, a second click brings it back.
          const FIRST_DISCLOSURE = `${CARD} [data-slot="session-transcript-shell-row"] [data-slot="tool-call-header-disclosure"]`;
          const firstRowTermCount = () =>
            app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(SHELL_ROWS)})[0]
                 .querySelectorAll('[data-slot="terminal-content"]').length`,
            );
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(FIRST_DISCLOSURE)}) !== null`,
            ),
            "shell block has the header expand/collapse chevron",
          ).toBe(true);
          expect(await firstRowTermCount(), "output visible before collapse").toBe(1);
          await app.click(FIRST_DISCLOSURE);
          await new Promise((r) => setTimeout(r, 150));
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHELL_ROWS)})[0]
               .querySelectorAll('[data-slot="terminal-content"]').length === 0`,
            { timeoutMs: 4000 },
          );
          await app.click(FIRST_DISCLOSURE);
          await new Promise((r) => setTimeout(r, 150));
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SHELL_ROWS)})[0]
               .querySelectorAll('[data-slot="terminal-content"]').length === 1`,
            { timeoutMs: 4000 },
          );

          // Interleaved order + the [P11] non-context styling hooks.
          const liveOrder = await participantOrder(app);
          expect(liveOrder).toEqual([
            "user",
            "assistant",
            "shell",
            "shell",
            "shell",
            "shell",
          ]);

          // --- Maker ▸ Reload → real resume replay + ledger restore. ---
          await app.appReload();
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 15_000 },
          );
          await app.spawnSessionResume("A", { tugSessionId: SID, projectDir });

          // The replayed Claude turn and the four restored exchanges must
          // both land — then hold the identical interleave.
          await app.waitForCondition<boolean>(
            `(function(){
              var shells = document.querySelectorAll(${JSON.stringify(SHELL_ROWS)});
              var entries = document.querySelectorAll(${JSON.stringify(ENTRIES)});
              return shells.length === 4 && entries.length >= 6;
            })()`,
            { timeoutMs: 20_000 },
          );

          const reloadedOrder = await participantOrder(app);
          expect(
            reloadedOrder,
            "reload must reproduce the identical row order ([P07])",
          ).toEqual(liveOrder);

          const restored = await shellRowFacts(app);
          expect(restored.length).toBe(4);
          expect(restored[0].command).toBe("echo hello-from-shell");
          expect(restored[0].output).toContain("hello-from-shell");
          expect(restored[0].footer).toContain("exit 0");
          expect(restored[1].command).toBe("cd sub");
          expect(restored[2].command).toBe("pwd");
          expect(restored[2].output).toContain(join(projectDir, "sub"));
          expect(restored[3].command).toBe('echo "sid=$TUG_SESSION_ID"');
          expect(restored[3].output).toContain(`sid=${SID}`);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

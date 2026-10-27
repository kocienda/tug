/**
 * at0750-live-hook-node-test.test.ts — a bare `node --test` in a Session card
 * gets the report panel, through the app's own hook and the app's own
 * `tugtool`.
 *
 * The rewrite that wraps a known runner in `tugtool test run` lives in the
 * plugin's PreToolUse hook, and a Session card runs the hook the app bundle
 * ships — never the workspace's build. So a hook change reaches a card only
 * once the app is rebuilt, and every check of the rewrite that runs the Rust
 * function or a scratch project leaves that link unread. This file reads it.
 *
 * The drive, link by link as a live call takes it:
 *
 *   1. A stub tugcode (`TUGCODE_STUB_TRANSCRIPT_DIR`) plays one turn through
 *      the real feed: a Bash `tool_use` for `node --test` over a two-test
 *      fixture, and its `tool_result` a few seconds later. tugcast sees the
 *      call open exactly as it would a model's, so the call is a run that a
 *      report can attach to.
 *   2. The bundle's own `hooks/pre-tool-use.sh` is handed the payload Claude
 *      Code would hand it, and rewrites the command — the call's id
 *      exported, the runner inside the bundle's `tugtool test run`.
 *   3. The rewritten command runs as the call's shell would, with the
 *      session's `TUG_SESSION_ID`, so its reports go to the instance under
 *      test and attach to the call by its id.
 *
 * Then the call returns, and the block settles as the run it was: its strip
 * says PASS over `2/2 tests`, and expanded it is the finished panel. A test
 * run lists only its reds, so a green one has no rows to count; the two tests
 * are its fraction.
 *
 * Claude itself is the one link not driven: a real turn is not something a
 * derived selection should start, and what claude does with a hook's
 * `updatedInput` is Claude Code's contract, not Tug's.
 *
 * @covers tugplug/hooks/pre-tool-use.sh
 * @covers tugrust/crates/tugtool/src/commands/hook.rs
 * @covers tugrust/crates/tugtool/src/runners.rs
 * @covers tugrust/crates/tugtool/src/test_run.rs
 * @covers tugdeck/src/components/tugways/tug-report-panel.tsx
 * @covers tugdeck/src/components/tugways/cards/blocks/bash-tool-block.tsx
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TUGCODE_TRANSCRIPT_SCHEMA_VERSION, launchTugApp, note, type App } from "./_harness";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_NAME = "at0750-live-hook-node-test";
const TEST_TIMEOUT_MS = 60_000;
const IPC_VERSION = 2;

const CARD = "at0750-card";
const USE_ID = "toolu_at0750_node";
const COMMAND = "node --test fixture.test.mjs";
/**
 * Between the call opening and its result: the window the hooked command
 * runs in. A two-test `node --test` takes well under a second.
 */
const CALL_OPEN_MS = 5_000;
const BODY_READY_MS = 30_000;

const BLOCK = `[data-slot="bash-tool-block"][data-tool-use-id="${USE_ID}"]`;
const STRIP = `${BLOCK} [data-slot="bash-report-strip"]`;
const PANEL = `${BLOCK} [data-slot="tug-report-panel"]`;

const oneCard = {
  cards: [{ id: CARD, componentId: "session", title: "Hook", closable: true }],
  panes: [
    {
      id: `${CARD}-pane`,
      position: { x: 40, y: 40 },
      size: { width: 720, height: 560 },
      cardIds: [CARD],
      activeCardId: CARD,
      title: "",
      acceptsFamilies: ["maker"],
      slot: 0,
    },
  ],
  activePaneId: `${CARD}-pane`,
  imposition: { kind: "four-up", layout: "flow", sidebars: {} },
  hasFocus: true,
};

/** Two tests that pass, as `node --test` reads them. */
const FIXTURE = [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'test("adds", () => assert.equal(1 + 1, 2));',
  'test("joins", () => assert.equal(["a", "b"].join(""), "ab"));',
  "",
].join("\n");

/** One turn: the Bash call opens, and returns {@link CALL_OPEN_MS} later. */
function transcript(): unknown {
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    paceMs: CALL_OPEN_MS,
    turns: [
      {
        index: 0,
        description: "a bare node --test",
        outputs: [
          {
            type: "tool_use",
            msg_id: "stub-at0750-m1",
            seq: 0,
            tool_name: "Bash",
            tool_use_id: USE_ID,
            input: { command: COMMAND },
            ipc_version: IPC_VERSION,
          },
          { type: "tool_result", tool_use_id: USE_ID, output: "ok", is_error: false, ipc_version: IPC_VERSION },
          { type: "turn_complete", msg_id: "stub-at0750-m1", seq: 1, result: "success", ipc_version: IPC_VERSION },
        ],
      },
    ],
  };
}

function spawn(cmd: string[], opts: { cwd: string; env: Record<string, string>; stdin?: string }) {
  const proc = Bun.spawnSync(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout),
    err: new TextDecoder().decode(proc.stderr),
  };
}

describe.skipIf(!SHOULD_RUN)("AT0750: the live hook gives a bare node --test its panel", () => {
  test(
    "the app's hook wraps the runner, and the block settles as the run",
    async () => {
      const appBin = process.env.TUGAPP_DEBUG_PATH;
      expect(appBin, "the recipe names the app under test").toBeDefined();
      const bundle = appBin!.replace(/\/Contents\/MacOS\/[^/]+$/, "");
      const pluginRoot = join(bundle, "Contents/Resources/tugplug");
      const macos = join(bundle, "Contents/MacOS");

      const stubDir = stubDirectory();
      const project = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0750-project-")));
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0750-records-")));
      onTestRunEnd(() => {
        rmSync(project, { recursive: true, force: true });
        rmSync(scratch, { recursive: true, force: true });
      });
      writeFileSync(join(project, "fixture.test.mjs"), FIXTURE);
      const tugSessionId = randomUUID();
      writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript()));

      // The environment a session's shell has: the bundle's tools first on
      // PATH, the session's id, and — this being a test — the run's record
      // kept out of the user's own.
      const shellEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        PATH: `${macos}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        TUG_SESSION_ID: tugSessionId,
        TUG_TEST_RESULTS_DB: join(scratch, "test_results.db"),
      };
      delete shellEnv.TUG_TOOL_USE_ID;

      const app: App = await launchTugApp({ testName: TEST_NAME, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: oneCard, focusCardId: CARD });
        await app.spawnSessionNew(CARD, { tugSessionId, projectDir: project });
        const card = app.body(CARD);
        await card.waitForCondition<boolean>(
          `document.querySelector('[data-testid="session-card-transcript"]') !== null`,
          { timeoutMs: BODY_READY_MS },
        );

        await card.driveSession({ op: "send", text: "run the tests" });
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(BLOCK)})`, {
          timeoutMs: 10_000,
        });

        // The hook, as Claude Code runs it: `sh <script>`, the payload on stdin.
        const hook = spawn(["sh", join(pluginRoot, "hooks/pre-tool-use.sh")], {
          cwd: project,
          env: shellEnv,
          stdin: JSON.stringify({
            tool_name: "Bash",
            tool_input: { command: COMMAND },
            cwd: project,
            tool_use_id: USE_ID,
          }),
        });
        expect(hook.code, hook.err).toBe(0);
        const rewritten: string = JSON.parse(hook.out).hookSpecificOutput.updatedInput.command;
        note(`at0750 the hook's command: ${rewritten}`);
        expect(rewritten.startsWith(`# tug-call: ${USE_ID}\n`), "the call carries its id").toBe(true);
        expect(rewritten, "the runner runs inside the bundle's own tugtool").toContain(
          `${join(macos, "tugtool")} test run `,
        );
        expect(rewritten.endsWith(` -- ${COMMAND}`), "the runner as typed").toBe(true);

        // The call's shell runs it. The run reads its call id from this
        // shell's argv (`tugcore::call_id`), so the shell has to persist:
        // `sh -c` with one simple command execs it in its own place, argv and
        // mark gone, and Claude Code's own wrapper is a `&&` chain.
        const ran = spawn(["/bin/sh", "-c", `${rewritten} && :`], { cwd: project, env: shellEnv });
        note(`at0750 the run exited ${ran.code}`);
        expect(ran.code, ran.err).toBe(0);

        // The call returns: the block is the run it was.
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(STRIP)})`, {
          timeoutMs: CALL_OPEN_MS + 10_000,
        });
        const strip = await card.evalJS<string | null>(
          `(document.querySelector(${JSON.stringify(STRIP)}) || {}).textContent ?? null`,
        );
        expect(strip, "the strip says how the run ended").toContain("PASS");
        expect(
          await card.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(`${STRIP} [data-slot="tug-report-panel-fraction"]`)}) || {}).textContent ?? null`,
          ),
          "two tests, counted",
        ).toBe("2/2tests");

        await card.click(`${BLOCK} [data-slot="tool-call-header-disclosure"]`);
        await card.waitForCondition<boolean>(
          `!!document.querySelector(${JSON.stringify(`${PANEL}[data-state="finished"]`)})`,
          { timeoutMs: 10_000 },
        );
        expect(
          await card.evalJS<string | null>(
            `(document.querySelector(${JSON.stringify(`${PANEL} [data-slot="tug-report-panel-verdict"]`)}) || {}).textContent ?? null`,
          ),
        ).toContain("2");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

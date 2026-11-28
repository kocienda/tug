/**
 * at0912-mid-turn-send-acted-on.test.ts — a message typed during the last
 * command of a turn is acted on, in view, under its own row.
 *
 * ## Why this exists
 *
 * The report this answers: a second message sent while the turn's last
 * command ran was taken by claude, which ran the work it asked for, and the
 * card drew none of it — the commands passed in silence. The deck now sends
 * such a message at Return, holds a `Waiting` row until claude's
 * `command_lifecycle` says where it was taken in, and draws a turn claude
 * opened for it as a continuation of the exchange. Each link is pinned on
 * recorded frames in the unit suites; what no unit test can say is that a
 * real claude, given the gesture as a person makes it, ends with the work
 * drawn under the message that asked for it. So this file makes the gesture,
 * and it seats a real claude, so it is on demand only:
 *
 *     TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0912-mid-turn-send-acted-on.test.ts
 *
 * The command the turn runs is a script that sleeps, standing in for a build
 * (claude refuses a bare long `sleep` as a wasted wait). The second message
 * asks for a second script whose output, `published-42`, appears in neither
 * message, so finding it in the transcript means the command ran and was
 * drawn. Whichever way claude lands the message — merged into the turn at the
 * tool's result, or run as a turn of its own after it — the card must show
 * the message once, as a row, and the work after it.
 *
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugcode/src/session.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { rmScratchSession, seedScratchSession } from "./arc-fixture";

/**
 * Two gates: `TUGAPP_APP_TEST` is every app-test's; `TUG_REAL_CLAUDE` is this
 * file's own, because a real turn is not something a derived selection should
 * start on its own.
 */
const SHOULD_RUN =
  process.env.TUGAPP_APP_TEST === "1" && process.env.TUG_REAL_CLAUDE === "1";
const GATED_OFF = process.env.TUGAPP_APP_TEST === "1" && !SHOULD_RUN;

const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000912";
const CARD = '[data-card-id="A"]';
const TRANSCRIPT = `${CARD} .session-card-transcript`;
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const GHOST_ROW = `${CARD} [data-slot="session-transcript-ghost-row"]`;
const WAITING_ROW = `${GHOST_ROW}[data-waiting="true"]`;
const PERMISSION_ALLOW = `${CARD} [data-slot="session-permission-dialog"] .tug-inline-dialog-actions .tug-button-primary-action`;
/** Disabled for the whole of a turn — the turn-idle tell. */
const AI_CHIP_BUTTON = `${CARD} [data-slot="ai-chip"]`;

const BUILD = "./build.sh";
const PUBLISH = "./publish.sh";
/** What the second script prints; in neither message's text. */
const PUBLISHED = "published-42";
const SECOND = `Also, please run ${PUBLISH} with the Bash tool and tell me what it printed.`;

let projectDir = "";
let sessionDir = "";

function script(name: string, body: string): void {
  const path = join(projectDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  if (GATED_OFF) {
    note(
      "at0912 skipped",
      "real-claude only — run with TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0912-mid-turn-send-acted-on.test.ts",
    );
  }
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0912-")));
  script(BUILD, "sleep 10\necho built");
  script(PUBLISH, "printf 'published-%s\\n' 42");
  sessionDir = seedScratchSession(projectDir, SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmScratchSession(sessionDir);
  if (projectDir !== "") rmSync(projectDir, { recursive: true, force: true });
});

/** Answer any permission the turn asks for, the way a person would. */
const allow = (app: App): Promise<null> =>
  app.body("A").evalJS<null>(`(document.querySelector(${JSON.stringify(PERMISSION_ALLOW)})?.click(), null)`);

/** Poll `probe` in the card, answering permissions between reads. */
async function until(app: App, probe: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await allow(app);
    if (await app.body("A").evalJS<boolean>(probe)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

const transcriptText = `(document.querySelector(${JSON.stringify(TRANSCRIPT)})?.textContent ?? "")`;

/** The first command is running: its tool block is drawn and the turn is open. */
const buildRunning = `(() => {
  const chip = document.querySelector(${JSON.stringify(AI_CHIP_BUTTON)});
  return ${transcriptText}.includes(${JSON.stringify(BUILD)}) && chip !== null && chip.hasAttribute("disabled");
})()`;

/** Settled: the second script's output is drawn, no row waits, the turn is over. */
const settled = `(() => {
  const chip = document.querySelector(${JSON.stringify(AI_CHIP_BUTTON)});
  return ${transcriptText}.includes(${JSON.stringify(PUBLISHED)}) &&
    document.querySelector(${JSON.stringify(GHOST_ROW)}) === null &&
    chip !== null && !chip.hasAttribute("disabled");
})()`;

describe.skipIf(!SHOULD_RUN)("AT0912: a message sent during the last command is acted on in view", () => {
  test(
    "the second message waits, is taken in, and the work it asked for is drawn under its row",
    async () => {
      const app = await launchTugApp({ testName: "at0912-mid-turn-send-acted-on" });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        await app.body("A").nativeClickAtElement(EDITOR);
        // Keys sent before the editor holds the focus have no responder.
        await app.body("A").waitForCondition<boolean>(
          `document.hasFocus() && document.activeElement === document.querySelector(${JSON.stringify(EDITOR)})`,
          { timeoutMs: 10_000 },
        );
        await app.nativeType(
          `This is an automated test of sending a message while a tool runs. Please use the Bash tool to run ${BUILD} in the foreground; it stands in for a build and takes about ten seconds. When it finishes, reply with one short sentence.`,
        );
        await new Promise((r) => setTimeout(r, 200));
        await app.nativeKey("Escape");
        await new Promise((r) => setTimeout(r, 200));
        await app.nativeKey("Return", ["cmd"]);

        const running = await until(app, buildRunning, 90_000);
        if (!running) note("at0912 the card when the build never ran", await app.body("A").evalJS<string>(`${transcriptText}.slice(-1500)`));
        expect(running, "the turn reached its command").toBe(true);

        // ── The gesture: a second message while the command runs ─────────
        // Mid-turn, Escape is Stop, so none is pressed here; the text opens
        // no completion popup.
        await app.body("A").nativeClickAtElement(EDITOR);
        await app.nativeType(SECOND);
        await new Promise((r) => setTimeout(r, 200));
        await app.nativeKey("Return", ["cmd"]);

        // It went to claude at Return; claude takes it in no sooner than the
        // command's result, seconds away, so the row reads `Waiting` first.
        const waited = await until(app, `document.querySelector(${JSON.stringify(WAITING_ROW)}) !== null`, 5_000);
        expect(waited, "the second message's row reads Waiting while the command runs").toBe(true);

        const done = await until(app, settled, 180_000);
        const text = await app.body("A").evalJS<string>(transcriptText);
        if (!done) note("at0912 the transcript when it did not settle", text.slice(-2000));
        expect(done, "the work the second message asked for is drawn and the card is idle").toBe(true);

        // ── Under its own row, once ──────────────────────────────────────
        const at = text.indexOf(SECOND);
        expect(at, "the second message is drawn as a row").toBeGreaterThan(-1);
        expect(text.indexOf(SECOND, at + 1), "the second message is drawn once").toBe(-1);
        expect(text.indexOf(PUBLISHED, at), "the work comes after the message that asked for it").toBeGreaterThan(at);
        // The tool call it asked for is drawn after its row, not only the
        // reply that names the output (a tool block's output is folded).
        expect(text.indexOf(PUBLISH, at + SECOND.length), "the command it asked for is drawn after its row").toBeGreaterThan(at);
        note("at0912 settled", (await app.screenshot()).path);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

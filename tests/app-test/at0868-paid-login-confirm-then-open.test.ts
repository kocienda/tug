/**
 * at0868-paid-login-confirm-then-open.test.ts — a session never starts on a
 * pay-per-token login until the user confirms it, and confirming opens it.
 *
 * The project is a fixture whose own `.claude/settings.json` sets a FAKE
 * `ANTHROPIC_API_KEY` in its `env` block — the case `auth status` cannot see
 * and a session would use. The test machine's own login is never read or
 * changed: the gate reads the project's settings by name, and the key is a
 * placeholder string that no request is ever made with (the session opens and
 * is closed without a prompt).
 *
 *   1. Open from the picker → tugcast refuses the spawn, and the picker comes
 *      back with a notice naming the key, from this project's settings, and a
 *      Use This Login button.
 *   2. Use This Login → the identity is stored in the app's tugbank, and the
 *      same open is sent again and binds the card.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/paid-login.ts
 * @covers tugdeck/src/components/tugways/cards/session-picker-form.tsx
 * @covers tugdeck/src/components/tugways/cards/session-picker-notice-content.ts
 * @covers tugdeck/src/lib/session-control-actions.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/spawn.rs
 * @covers tugrust/crates/tugcast/src/feeds/claude_auth.rs
 * @covers tugrust/crates/tugcast/src/router.rs
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note } from "./_harness";
import { projectClaudeDir } from "./_harness/claude-home";
import { waitForBodyReady } from "./_harness/card-reach";
import { sessionCardShape, SESSION_CARD_SIZE_COMPACT } from "./_harness/shapes";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { mkSeededTugbank, rmTempTugbank, tugbankRead } from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const SHEET = '[data-slot="tug-sheet"]';
const OPEN = `${SHEET} [data-testid="session-card-picker-open"]`;
const NOTICE = `${SHEET} [data-testid="session-card-picker-notice"][data-notice-category="paid_login"]`;
const CONFIRM = `${SHEET} [data-testid="session-card-picker-notice-confirm-paid-login"]`;
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

function present(selector: string): string {
  return `document.querySelector(${JSON.stringify(selector)}) !== null`;
}

function text(selector: string): string {
  return `(function () {
    var node = document.querySelector(${JSON.stringify(selector)});
    return node === null ? "" : node.textContent;
  })()`;
}

describe.skipIf(!SHOULD_RUN)("AT0868: a pay-per-token login is confirmed before a session opens", () => {
  test(
    "refuses the open, names the project's key, and opens once it is confirmed",
    async () => {
      const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0868-project-")));
      onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
      const claudeDir = projectClaudeDir(projectDir);
      mkdirSync(claudeDir);
      writeFileSync(
        join(claudeDir, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_API_KEY: "at0868-placeholder-not-a-key" } }),
      );
      // The picker opens on the fixture project, which every page reads at mount.
      const tugbank = mkSeededTugbank([
        { domain: "dev.tugapp.app", key: "default-project-path", type: "string", value: projectDir },
      ]);
      const app = await launchTugApp({
        testName: "at0868-paid-login-confirm-then-open",
        env: { TUGBANK_PATH: tugbank },
      });
      try {
        await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
        await waitForBodyReady(app, "A");
        const body = app.body("A");
        await body.waitForCondition<boolean>(present(OPEN), { timeoutMs: 20_000 });

        // 1. Open → refused, and the picker names the login.
        await body.nativeClickAtElement(OPEN);
        await body.waitForCondition<boolean>(present(NOTICE), { timeoutMs: 20_000 });
        const notice = (await body.evalJS<string>(text(NOTICE))).trim();
        note(`at0868 notice: ${notice}`);
        expect(notice).toContain("This session would be billed per token");
        expect(notice).toContain(
          "an API key from ANTHROPIC_API_KEY in this project's Claude Code settings",
        );
        expect(
          tugbankRead(tugbank, "dev.tugapp.auth", "paid_login_confirmed"),
          "nothing is confirmed before the user says so",
        ).toBeNull();

        // 2. Use This Login → stored, and the same open goes again and binds.
        await body.nativeClickAtElement(CONFIRM);
        await body.waitForCondition<boolean>(present(PROMPT_INPUT), { timeoutMs: 30_000 });
        const stored = tugbankRead<string>(tugbank, "dev.tugapp.auth", "paid_login_confirmed");
        note(`at0868 stored: ${JSON.stringify(stored)}`);
        expect(stored?.value).toBe("environment_key:ANTHROPIC_API_KEY");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0868] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
        rmTempTugbank(tugbank);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

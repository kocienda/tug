/**
 * at0094-permission-scope-routing.test.ts — the add-rule scope picker routes
 * each write to the correct settings file ([AT0094]).
 *
 * ## Why this exists
 *
 * Claude Code merges rules across scopes, reading each from a distinct file:
 * Local → `.claude/settings.local.json`, Project → `.claude/settings.json`,
 * User → `~/.claude/settings.json`. The editor's scope radios must write to the
 * file the chosen scope names — picking the wrong file would silently land the
 * rule where Claude Code doesn't look (or commit a local-only rule into the
 * shared project file). This adds one rule at the default Local scope and one
 * after selecting Project, then asserts clean separation:
 *
 *   - the Local rule is in `settings.local.json` and NOT in `settings.json`;
 *   - the Project rule is in `settings.json` and NOT in `settings.local.json`.
 *
 * Both scope files live under the temp `projectDir`, so writes are isolated.
 * User scope writes to the real `~/.claude` and is deliberately not exercised
 * here — its path resolution is covered by the tugcast unit test.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/permission-rules-store.ts
 * @covers tugdeck/src/lib/permission-rules.ts
 * @covers tugrust/crates/tugcast/src/permissions.rs
 * @covers tugdeck/src/components/tugways/cards/permission-rules-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-radio-group.css
 * @covers tugdeck/src/components/tugways/tug-radio-group.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="tug-sheet"]';
const tabSel = (id: string): string => `${SHEET} .tug-tab[data-testid="tug-tab-${id}"]`;
const ADD_INPUT = `${SHEET} .permission-rules-add-input`;
const ADD_SUBMIT = `${SHEET} [data-slot="permission-rules-add-submit"]`;

const LOCAL_RULE = "Bash(at0094-local:*)";
const PROJECT_RULE = "Bash(at0094-project:*)";

let projectDir = "";
const localFile = (): string => join(projectDir, ".claude", "settings.local.json");
const projectFile = (): string => join(projectDir, ".claude", "settings.json");

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0094-scope-"));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 820, height: 640 },
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

/** The `permissions.allow` entries of a settings file, or `[]` if absent. */
function allowIn(file: string): string[] {
  if (!existsSync(file)) return [];
  const root = JSON.parse(readFileSync(file, "utf-8")) as {
    permissions?: { allow?: unknown };
  };
  const allow = root.permissions?.allow;
  return Array.isArray(allow) ? allow.filter((e): e is string => typeof e === "string") : [];
}

async function waitFor(
  read: () => string[],
  predicate: (entries: string[]) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = read();
    if (predicate(last)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label}: timed out. allow=${JSON.stringify(last)}`);
}

describe.skipIf(!SHOULD_RUN)(
  "AT0094: the scope picker routes the write to the chosen scope's file",
  () => {
    test(
      "Local rule → settings.local.json; Project rule → settings.json; no crossover",
      async () => {
        const app = await launchTugApp({ testName: "at0094-permission-scope-routing" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A");

          // Paced keystrokes (one batch, ~40ms apart) so the OS doesn't drop
          // keys the way a fast nativeType can under load.
          await app.nativeClickAtElement(PROMPT_INPUT);
          await app.nativeType("/permissions");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Escape");
          await new Promise((r) => setTimeout(r, 200));
          await app.nativeKey("Return", ["cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
            { timeoutMs: 6000 },
          );

          // Allow tab → expand the add accordion.
          await app.evalJS<void>(
            `document.querySelector(${JSON.stringify(tabSel("allow"))}).click()`,
          );
          await app.evalJS<void>(
            `document.querySelector(${JSON.stringify(`${SHEET} .tug-accordion-trigger`)}).click()`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(ADD_INPUT)}) !== null`,
            { timeoutMs: 4000 },
          );

          const addRule = async (entry: string): Promise<void> => {
            await app.evalJS<void>(
              `window.__tug.type(${JSON.stringify(ADD_INPUT)}, ${JSON.stringify(entry)})`,
            );
            await app.waitForCondition<boolean>(
              `(function(){var b=document.querySelector(${JSON.stringify(ADD_SUBMIT)});return b!==null && !b.disabled;})()`,
              { timeoutMs: 4000 },
            );
            await app.evalJS<void>(
              `document.querySelector(${JSON.stringify(ADD_SUBMIT)}).click()`,
            );
          };

          // 1. Default scope is Local → writes settings.local.json.
          await addRule(LOCAL_RULE);
          await waitFor(() => allowIn(localFile()), (a) => a.includes(LOCAL_RULE), "local add");

          // 2. Select the "Project settings" radio (exact label — "Project
          //    settings (local)" is the Local option). Then add → settings.json.
          await app.evalJS<void>(
            `(function(){
              var items = document.querySelectorAll(${JSON.stringify(`${SHEET} [data-slot="tug-radio-item"]`)});
              for (var i = 0; i < items.length; i++) {
                var lbl = items[i].querySelector('.tug-radio-item-label');
                if (lbl && lbl.textContent.trim() === 'Project settings') { items[i].click(); return; }
              }
              throw new Error('Project settings radio not found');
            })()`,
          );
          await addRule(PROJECT_RULE);
          await waitFor(() => allowIn(projectFile()), (a) => a.includes(PROJECT_RULE), "project add");

          // Clean separation: each rule is only in its scope's file.
          expect(allowIn(localFile()), "local file holds only the local rule").toEqual([
            LOCAL_RULE,
          ]);
          expect(allowIn(projectFile()), "project file holds only the project rule").toEqual([
            PROJECT_RULE,
          ]);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0094] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

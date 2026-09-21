/**
 * at0090-permissions-rules-editor.test.ts — the `/permissions` rules editor
 * opens from the prompt, tabs switch, and add/remove round-trips to the
 * settings file via tugcast's `/api/permissions` endpoint ([AT0090]).
 *
 * ## Why this exists
 *
 * `/permissions` is the first live consumer of the local slash-command
 * dispatch layer ([#step-1c]) and the first session-card surface that reads and
 * writes the on-disk permission **rules** ([#step-1-6]). This test exercises
 * the whole chain end to end against the real app:
 *
 *   1. Typing `/permissions` and submitting opens the card-scoped editor sheet
 *      (the raw-text local-command path: submit → `matchLocalSlashCommand` →
 *      key-card `RUN_SLASH_COMMAND` → the session card's surface).
 *   2. The editor shows the five terminal tabs and switches between them.
 *   3. Adding a rule writes it to `<cwd>/.claude/settings.local.json` through
 *      the `/api/permissions/rule` endpoint (the real Rust handler + file IO);
 *      removing it takes it back out.
 *
 * The session `cwd` comes from the bound session's `projectDir`, so the test
 * points it at a fresh temp dir — the add/remove writes never touch the real
 * repo settings, and the test reads the file back directly to assert the write.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/permission-rules-store.ts
 * @covers tugdeck/src/lib/permission-rules.ts
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugrust/crates/tugcast/src/permissions.rs
 * @covers tugdeck/src/components/tugways/cards/permission-rules-editor.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="tug-sheet"]';
// Tabs render through TugTabBar: each tab is a `.tug-tab` with a
// `data-testid="tug-tab-<id>"` and a `.tug-tab-title` label span.
const TAB_TITLES = `${SHEET} .tug-tab .tug-tab-title`;
const tabSel = (id: string): string => `${SHEET} .tug-tab[data-testid="tug-tab-${id}"]`;
const DESCRIPTION = `${SHEET} .permission-rules-description`;
const ADD_INPUT = `${SHEET} .permission-rules-add-input`;
const ADD_SUBMIT = `${SHEET} [data-slot="permission-rules-add-submit"]`;
const MARKER = "Bash(at0090-marker:*)";

// A temp project root: the editor resolves its cwd from the bound session's
// projectDir, so every read/write lands here — never the real repo.
let projectDir = "";
const settingsPath = (): string => join(projectDir, ".claude", "settings.local.json");

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0090-perms-"));
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
        size: { width: 820, height: 620 },
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

/** The `permissions.allow` array on disk, or `[]` when the file is absent. */
function allowRules(): string[] {
  const path = settingsPath();
  if (!existsSync(path)) return [];
  const root = JSON.parse(readFileSync(path, "utf-8")) as {
    permissions?: { allow?: unknown };
  };
  const allow = root.permissions?.allow;
  return Array.isArray(allow) ? allow.filter((e): e is string => typeof e === "string") : [];
}

/** Poll the on-disk allow list until `predicate` holds, or throw on timeout. */
async function waitForAllow(
  predicate: (allow: string[]) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = allowRules();
    if (predicate(last)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: timed out. allow=${JSON.stringify(last)}`);
}

describe.skipIf(!SHOULD_RUN)(
  "AT0090: /permissions rules editor opens, tabs switch, add/remove writes settings",
  () => {
    test(
      "type /permissions → editor; switch tabs; add + remove a rule round-trips to disk",
      async () => {
        const app = await launchTugApp({ testName: "at0090-permissions-rules-editor" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A");

          // 1. Open the editor via the real submit path. Type `/permissions`,
          //    dismiss the completion popup (Escape leaves the raw text), then
          //    force-submit with Cmd+Enter. The raw `/permissions` text is
          //    recognized as a local command and dispatched, opening the sheet.
          // Settle between native events (~200ms, matching at0045/at0048). The
          // press-and-hold popover that used to steal mid-type focus is disabled
          // at launch (`-ApplePressAndHoldEnabled NO`), so a single nativeType
          // lands cleanly.
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

          // 1b. Regression guard for the pane-focus-controller fix: a real
          // click on an input inside the sheet must focus it. The sheet is
          // portaled into the pane frame (a sibling of the card host), so the
          // controller must NOT suppress its mousedown focus the way it does
          // for pane chrome.
          const SEARCH = `${SHEET} .permission-rules-search`;
          await app.nativeClickAtElement(SEARCH);
          await app.waitForCondition<boolean>(
            `document.activeElement === document.querySelector(${JSON.stringify(SEARCH)})`,
            { timeoutMs: 4000 },
          );

          // 2. The editor shows the five terminal tabs in order.
          const tabLabels = await app.evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(TAB_TITLES)})).map(function(t){return t.textContent.trim();})`,
          );
          expect(tabLabels, "the five terminal tabs render in order").toEqual([
            "Recently denied",
            "Allow",
            "Ask",
            "Deny",
            "Workspace",
          ]);

          // Default tab is Allow.
          expect(
            await app.evalJS<string | null>(
              `(function(){var el=document.querySelector(${JSON.stringify(`${SHEET} .tug-tab[data-active="true"] .tug-tab-title`)});return el?el.textContent.trim():null;})()`,
            ),
          ).toBe("Allow");

          // Switching to Deny updates the description copy (DOM click fires the
          // tab's onClick → selectTab through the chain, deterministically).
          await app.evalJS<void>(
            `document.querySelector(${JSON.stringify(tabSel("deny"))}).click()`,
          );
          await app.waitForCondition<boolean>(
            `(function(){var el=document.querySelector(${JSON.stringify(DESCRIPTION)});return el!==null && el.textContent.indexOf("reject")!==-1;})()`,
            { timeoutMs: 4000 },
          );

          // 3. Add a rule on the Allow tab and assert it lands on disk. The
          //    add form lives in a collapsed accordion — expand it first.
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

          // Keyboard-descent guard: the add-form controls (matcher field, scope
          // radios, Add) are authored as focusables in the accordion section's
          // own scope, so the open "Add a rule" header is descendable — Enter on
          // it lands the key view inside (the descend mechanism itself is proven
          // generically by at0120). Without this authoring the section holds no
          // focusables and there is no way to reach the form by keyboard.
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(`${SHEET} .permission-rules-add [data-tug-focusable]`)}).length`,
            ),
            "the add-rule form's controls are authored as focusables (section is descendable)",
          ).toBeGreaterThan(0);

          expect(allowRules(), "no marker rule before add").not.toContain(MARKER);

          // Fill the controlled matcher input via the native-setter type
          // helper (dispatches the input event React's onChange listens to —
          // no focus dependency, unlike a posted CGEvent). The Add button
          // enabling is the proof the draft state captured the text; the rule
          // is then submitted by clicking Add.
          await app.evalJS<void>(
            `window.__tug.type(${JSON.stringify(ADD_INPUT)}, ${JSON.stringify(MARKER)})`,
          );
          await app.waitForCondition<boolean>(
            `(function(){var b=document.querySelector(${JSON.stringify(ADD_SUBMIT)});return b!==null && !b.disabled;})()`,
            { timeoutMs: 4000 },
          );
          await app.evalJS<void>(
            `document.querySelector(${JSON.stringify(ADD_SUBMIT)}).click()`,
          );

          await waitForAllow(
            (allow) => allow.includes(MARKER),
            "add must write the rule to settings.local.json",
          );

          // The new rule appears as a row in the list.
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(`${SHEET} .permission-rule-matcher`)})).some(function(el){return el.textContent.trim() === ${JSON.stringify(MARKER)};})`,
            { timeoutMs: 4000 },
          );

          // 4. Remove the rule: the trash button (the row's only button) opens
          //    a danger confirm popover; confirming removes the rule from disk.
          await app.evalJS<void>(
            `(function(){
              var rows = document.querySelectorAll(${JSON.stringify(`${SHEET} .tug-list-row`)});
              for (var i = 0; i < rows.length; i++) {
                var m = rows[i].querySelector('.permission-rule-matcher');
                if (m && m.textContent.trim() === ${JSON.stringify(MARKER)}) {
                  var btn = rows[i].querySelector('button');
                  if (btn) btn.click();
                  return;
                }
              }
              throw new Error('marker row not found for removal');
            })()`,
          );
          // Removal requires a deliberate confirm — click the popover's danger
          // "Delete" button (the trash button itself carries no text label).
          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll('button')).some(function(b){return b.textContent.trim() === 'Delete';})`,
            { timeoutMs: 4000 },
          );
          await app.evalJS<void>(
            `(function(){
              var btn = Array.from(document.querySelectorAll('button')).find(function(b){return b.textContent.trim() === 'Delete';});
              if (!btn) throw new Error('confirm Delete button not found');
              btn.click();
            })()`,
          );

          await waitForAllow(
            (allow) => !allow.includes(MARKER),
            "remove must take the rule back out of settings.local.json",
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0090-permissions-rules-editor] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

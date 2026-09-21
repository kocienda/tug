/**
 * at0093-permission-buckets.test.ts — every `/permissions` tab writes to the
 * exact `permissions` bucket Claude Code reads, and the write is a
 * non-destructive merge ([AT0093]).
 *
 * ## Why this exists
 *
 * at0090 proves the Allow tab round-trips; this proves the other three editable
 * tabs target the right key and that adding a rule preserves the rest of the
 * settings file — the "modify the underlying resource the way Claude Code
 * expects" guarantee. With a pre-seeded `settings.local.json` (an existing
 * allow rule, a `defaultMode`, and an unrelated key), it adds one entry on each
 * of Allow / Ask / Deny / Workspace and asserts:
 *
 *   - Allow → `permissions.allow`, Ask → `permissions.ask`,
 *     Deny → `permissions.deny`, Workspace → `permissions.additionalDirectories`.
 *   - The pre-existing allow rule, `defaultMode`, and the unrelated key all
 *     survive (read-modify-write, not clobber) — exactly the shape Claude Code
 *     reloads live.
 *
 * cwd comes from the bound session's `projectDir` (a temp dir), so writes never
 * touch the real repo. Local scope only — scope routing is at0094, and user
 * scope (`~/.claude`) is covered by the tugcast unit test, never written here.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/permission-rules-store.ts
 * @covers tugdeck/src/lib/permission-rules.ts
 * @covers tugrust/crates/tugcast/src/permissions.rs
 * @covers tugdeck/src/components/tugways/cards/permission-rules-editor.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = '[data-slot="tug-sheet"]';
const tabSel = (id: string): string => `${SHEET} .tug-tab[data-testid="tug-tab-${id}"]`;
const ADD_SUBMIT = `${SHEET} [data-slot="permission-rules-add-submit"]`;

let projectDir = "";
const settingsLocal = (): string => join(projectDir, ".claude", "settings.local.json");

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // Spawn clean (no pre-seeded settings — a project that spawns with a
  // non-default permission mode disrupts the prompt; out of scope here). The
  // pre-seed is written after the editor opens; the first add's read-modify-
  // write still has to preserve it.
  projectDir = mkdtempSync(join(tmpdir(), "at0093-buckets-"));
});

/** Pre-seed settings.local.json with keys every add must preserve. */
function seedSettings(): void {
  mkdirSync(join(projectDir, ".claude"), { recursive: true });
  writeFileSync(
    settingsLocal(),
    JSON.stringify({
      permissions: { defaultMode: "acceptEdits", allow: ["WebSearch"] },
      spinnerTipsEnabled: false,
    }),
  );
}

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

/** Read the whole settings.local.json object, or `{}` if absent. */
function readSettings(): Record<string, unknown> {
  const path = settingsLocal();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

/** The string entries of one `permissions` bucket in settings.local.json. */
function bucket(key: string): string[] {
  const perms = (readSettings().permissions ?? {}) as Record<string, unknown>;
  const arr = perms[key];
  return Array.isArray(arr) ? arr.filter((e): e is string => typeof e === "string") : [];
}

async function waitForBucket(
  key: string,
  predicate: (entries: string[]) => boolean,
  label: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = bucket(key);
    if (predicate(last)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${label}: timed out. ${key}=${JSON.stringify(last)}`);
}

describe.skipIf(!SHOULD_RUN)(
  "AT0093: each tab writes to its bucket; adds preserve the rest of the file",
  () => {
    test(
      "Allow/Ask/Deny/Workspace add → correct bucket; other keys survive",
      async () => {
        const app = await launchTugApp({ testName: "at0093-permission-buckets" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A");

          // Open the editor by typing `/permissions`. Settle between native
          // events (~200ms, at0045/at0048 idiom); the focus-stealing
          // press-and-hold popover is disabled at launch
          // (`-ApplePressAndHoldEnabled NO`). The real open path is at0090.
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

          // Now seed the keys the adds must preserve, on disk, before any add.
          // The editor loaded an empty file on open; each add's read-modify-
          // write (the real Rust handler) reads this fresh and must keep it.
          seedSettings();

          // Add one entry on a given tab and wait for it to land in `key`.
          // The add form lives in a collapsed accordion; expand it if the
          // input isn't already showing (the RulePanel instance — and thus the
          // accordion's open state — persists across tab switches, so this is a
          // no-op after the first expand).
          const addOnTab = async (
            tabId: string,
            key: string,
            entry: string,
          ): Promise<void> => {
            // The Workspace tab's entry is a TugFileChooser; the rule tabs use
            // the plain matcher input.
            const input =
              tabId === "workspace"
                ? `${SHEET} .tug-file-chooser-input`
                : `${SHEET} .permission-rules-add-input`;
            await app.evalJS<void>(
              `document.querySelector(${JSON.stringify(tabSel(tabId))}).click()`,
            );
            await app.evalJS<void>(
              `(function(){
                if (document.querySelector(${JSON.stringify(input)}) === null) {
                  var t = document.querySelector(${JSON.stringify(`${SHEET} .tug-accordion-trigger`)});
                  if (t) t.click();
                }
              })()`,
            );
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(input)}) !== null`,
              { timeoutMs: 4000 },
            );
            await app.evalJS<void>(
              `window.__tug.type(${JSON.stringify(input)}, ${JSON.stringify(entry)})`,
            );
            await app.waitForCondition<boolean>(
              `(function(){var b=document.querySelector(${JSON.stringify(ADD_SUBMIT)});return b!==null && !b.disabled;})()`,
              { timeoutMs: 4000 },
            );
            await app.evalJS<void>(
              `document.querySelector(${JSON.stringify(ADD_SUBMIT)}).click()`,
            );
            await waitForBucket(key, (e) => e.includes(entry), `add to ${tabId}`);
          };

          await addOnTab("allow", "allow", "Bash(at0093-allow:*)");
          await addOnTab("ask", "ask", "Bash(at0093-ask:*)");
          await addOnTab("deny", "deny", "Bash(at0093-deny:*)");
          await addOnTab("workspace", "additionalDirectories", "at0093-dir");

          // Each bucket holds exactly what its tab wrote (+ the pre-seeded
          // allow rule), and nothing leaked across buckets.
          expect(bucket("allow").sort()).toEqual(
            ["Bash(at0093-allow:*)", "WebSearch"].sort(),
          );
          expect(bucket("ask")).toEqual(["Bash(at0093-ask:*)"]);
          expect(bucket("deny")).toEqual(["Bash(at0093-deny:*)"]);
          expect(bucket("additionalDirectories")).toEqual(["at0093-dir"]);

          // Non-destructive merge: the mode and the unrelated key survive.
          const settings = readSettings();
          const perms = settings.permissions as Record<string, unknown>;
          expect(perms.defaultMode, "defaultMode preserved").toBe("acceptEdits");
          expect(settings.spinnerTipsEnabled, "unrelated key preserved").toBe(false);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0093] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

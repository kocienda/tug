/**
 * at0222-one-shot-commands.test.ts — the one-shot verbs typed into the
 * Prompt route ([AT0222]).
 *
 * ## Why this exists
 *
 * A one-shot verb consumes a single submission and leaves the route where it
 * was: `/shell <cmd>` runs one exchange against the card's shell session and
 * returns you to the prompt. There is one command namespace — the `/` one —
 * so the popup is the whole inventory.
 *
 * ## Test matrix
 *
 *   1. `/shell echo …` lands a settled shell exchange row.
 *   2. One namespace: the `/` popup offers the one-shot verbs alongside the
 *      ordinary local commands, and a leading `!` opens no popup at all.
 *   3. Live shell auto-insert: typing `git ` materializes the shell chip at
 *      the head; deleting it latches the decline (typing on, the next space
 *      never re-inserts).
 *
 * Transcript find has its own door (⌘F) and its own suites — `at0339` for the
 * bar, `at0602` and `at0603` for the matches — so it is not asserted here.
 *
 * Gating: DISABLED (`describe.skip`) — the auto-insert case pins the
 * bare-command routing decision to the simplistic login-PATH membership
 * check, which an upcoming feature replaces. Re-enable
 * (`describe.skipIf(!SHOULD_RUN)`) once that lands and the bare-typed
 * classifier is the thing worth asserting.
 *
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-z1b.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "a7c0d1ea-0000-4000-8000-00000000a222";

const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

/** Two plain turns, each carrying one `oneshotmark` occurrence. */
function buildFixtureJsonl(cwd: string, sessionId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const usage = {
    input_tokens: 1000,
    output_tokens: 50,
    cache_creation_input_tokens: 10,
    cache_read_input_tokens: 5000,
  };
  const texts = [
    "oneshotmark alpha sits in the first reply",
    "oneshotmark omega sits in the second reply",
  ];
  const lines: unknown[] = [];
  let parent: string | null = null;
  let seq = 1;
  let clock = Date.parse("2026-06-17T10:00:00.000Z");
  for (const [i, text] of texts.entries()) {
    const userUuid = `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
    clock += 5000;
    lines.push({
      ...base,
      parentUuid: parent,
      type: "user",
      uuid: userUuid,
      timestamp: new Date(clock).toISOString(),
      message: { role: "user", content: [{ type: "text", text: `ask ${i}` }] },
    });
    parent = userUuid;
    const aUuid = `00000000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
    clock += 5000;
    lines.push({
      ...base,
      parentUuid: parent,
      type: "assistant",
      uuid: aUuid,
      timestamp: new Date(clock).toISOString(),
      message: {
        id: `msg-oneshot-${i}`,
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage,
      },
    });
    parent = aUuid;
  }
  return lines.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

let projectDir = "";
let fixtureDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0222-proj-")));
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
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 860, height: 720 },
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

const EDITOR_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const COMPLETION_MENU_SELECTOR = '[data-slot="tug-completion-menu"]';

/** The one-shot verbs that must appear in the single `/` inventory. */
const ONE_SHOT_VERBS = ["shell", "btw"] as const;

async function mountAndReplay(app: App): Promise<void> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
  await app.spawnSessionResume("A", { tugSessionId: SID, projectDir });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('[data-card-id="A"] [data-tug-list-cell-index]').length >= 4`,
    { timeoutMs: 30_000 },
  );
}

/** Focus the editor, type `line`, settle, and force-submit with ⌘Enter. */
async function submitLine(app: App, line: string): Promise<void> {
  await app.nativeClickAtElement(EDITOR_SELECTOR);
  await app.nativeType(line);
  await new Promise((r) => setTimeout(r, 150));
  await app.nativeKey("Enter", ["cmd"]);
}


describe.skip("AT0222: one-shot verbs in the Prompt route", () => {
  test(
    "/shell runs one exchange into the transcript",
    async () => {
      const app = await launchTugApp({ testName: "at0222-shell" });
      try {
        await mountAndReplay(app);

        await submitLine(app, "/shell echo oneshot-shell-probe");
        await app.waitForCondition<boolean>(
          `(() => {
            const rows = document.querySelectorAll('[data-slot="session-transcript-shell-row"]');
            if (rows.length === 0) return false;
            const row = rows[rows.length - 1];
            const foot = row.querySelector('[data-slot="session-z1b-end-state"]');
            return foot !== null && (foot.textContent || '').includes('exit') &&
              (row.textContent || '').includes('oneshot-shell-probe');
          })()`,
          { timeoutMs: 20_000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "one namespace: `/` offers the one-shot verbs; a leading `!` opens nothing",
    async () => {
      const app = await launchTugApp({ testName: "at0222-gating" });
      try {
        await mountAndReplay(app);

        const readPopupLabels = async (): Promise<string[]> => {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPLETION_MENU_SELECTOR)}) !== null`,
            { timeoutMs: 4000 },
          );
          const labels = await app.evalJS<string>(
            `(() => {
              const popup = document.querySelector(${JSON.stringify(COMPLETION_MENU_SELECTOR)});
              if (!popup) return "[]";
              const items = popup.querySelectorAll(".tug-completion-menu-item");
              return JSON.stringify(Array.from(items).map((el) => (el.textContent || '').trim()));
            })()`,
          );
          return JSON.parse(labels) as string[];
        };

        // The `/` popup is the whole inventory: ordinary local commands AND
        // the one-shot verbs that used to wear the other sigil.
        await app.nativeClickAtElement(EDITOR_SELECTOR);
        await app.nativeType("/");
        const slashNames = await readPopupLabels();
        expect(slashNames.length).toBeGreaterThan(0);
        for (const verb of ONE_SHOT_VERBS) {
          expect(
            slashNames.some((n) => n === verb || n.startsWith(`${verb} `)),
            `"/${verb}" must be offered by the / popup`,
          ).toBe(true);
        }
        expect(
          slashNames.some((n) => n.includes("permissions")),
          "ordinary local commands stay offered",
        ).toBe(true);

        // A leading `!` is prose: no popup, no second namespace.
        await app.nativeKey("Escape");
        await app.nativeKey("Backspace");
        await app.nativeType("!");
        await new Promise((r) => setTimeout(r, 400));
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(COMPLETION_MENU_SELECTOR)}) === null`,
          ),
          "a leading `!` must open no completion popup",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "typing `git ` live-inserts the shell chip; deleting it latches the decline",
    async () => {
      const app = await launchTugApp({ testName: "at0222-autoinsert" });
      const CHIP_SELECTOR = `${EDITOR_SELECTOR} img[data-atom-type="command"][data-atom-value="shell"]`;
      const readChipCount = async (): Promise<number> =>
        await app.evalJS<number>(
          `document.querySelectorAll(${JSON.stringify(CHIP_SELECTOR)}).length`,
        );
      try {
        await mountAndReplay(app);

        // The gate reads the login-PATH command set, which loads async after
        // bind (`null` set always answers no) — so retype until it answers.
        // Emptying the doc resets the per-draft latches, so retries are safe.
        await app.nativeClickAtElement(EDITOR_SELECTOR);
        let inserted = false;
        for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
          await app.nativeType("git ");
          try {
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(CHIP_SELECTOR)}) !== null`,
              { timeoutMs: 2000 },
            );
            inserted = true;
          } catch {
            await app.nativeKey("a", ["cmd"]);
            await app.nativeKey("Backspace");
          }
        }
        expect(inserted, "the shell chip must auto-insert on `git `").toBe(true);

        // Deleting the auto-inserted chip latches the decline. Walk the caret
        // to the head and forward-delete the chip + its following space
        // (doc: `⟨chip⟩ git ` → `git `), then retype the exact trigger shape
        // — Backspace the trailing space and type it again so the last edit
        // is a typed space on a doc of exactly `git ` — and assert the chip
        // does NOT come back.
        await app.nativeKey("ArrowLeft", ["cmd"]);
        await app.nativeKey("Delete"); // forward delete: the chip
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP_SELECTOR)}) === null`,
          { timeoutMs: 4000 },
        );
        await app.nativeKey("Delete"); // forward delete: the chip's space
        await app.nativeKey("ArrowRight", ["cmd"]);
        await app.nativeKey("Backspace");
        await app.nativeType(" ");
        await new Promise((r) => setTimeout(r, 400));
        expect(await readChipCount()).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * at0655-change-directory-carries-context.test.ts — `/cd` moves a card into
 * another directory and the conversation comes with it.
 *
 * ## Why this exists
 *
 * A directory change is a swap: the card spawns a new session in the target
 * directory, forked from its current claude session (`--resume <parent>
 * --fork-session --session-id <new>`), and the ack re-seats the binding. Each
 * link is pinned in isolation — tugcode's fork argv and pending rule, tugcast's
 * resolution and server-side close, the deck's settle and divider — but what
 * no unit test can say is that a real claude, forked this way, still knows what
 * was said before the move and now runs in the new directory. That is this
 * file, and so it is real-claude and on demand only:
 *
 *     TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0655-change-directory-carries-context.test.ts
 *
 * ## What it walks
 *
 * The card opens on a session in `A` whose history asks claude to remember a
 * word. `/cd <B>` moves it: the binding reads `B`, and before any new prompt
 * the transcript shows the carried turn with a `Directory changed` divider
 * after it. A reload replays the same thing — the fork's own JSONL does not
 * exist until the first turn, so this is the pending path, reading the
 * parent's transcript from `A`. Then a real turn asks for the word and the
 * cwd, and the answer holds both. On disk the fork is `B`'s alone and the
 * parent is untouched. Last, the refusal: mid-turn, `/cd` is declined and the
 * card stays in `B`.
 *
 * @covers tugcode/src/session.ts
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_bridge.rs
 * @covers tugdeck/src/lib/directory-change.ts
 * @covers tugdeck/src/components/tugways/cards/session-card.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { encodeProjectDir } from "./arc-fixture";

/**
 * Two gates: `TUGAPP_APP_TEST` is every app-test's; `TUG_REAL_CLAUDE` is this
 * file's own, because real turns against a real claude are not something a
 * derived selection should start on its own.
 */
const SHOULD_RUN =
  process.env.TUGAPP_APP_TEST === "1" && process.env.TUG_REAL_CLAUDE === "1";
const GATED_OFF = process.env.TUGAPP_APP_TEST === "1" && !SHOULD_RUN;

const TEST_TIMEOUT_MS = 600_000;

/** The parent session in `A`. `claude --resume` needs a UUID. */
const PARENT_SID = "a7c0d1ea-0000-4000-8000-000000000655";
/** The word the parent's history asks claude to keep. */
const WORD = "QUARTZ-HERON";

const CARD = '[data-card-id="A"]';
const TRANSCRIPT = `${CARD} .session-card-transcript`;
const DIVIDER = `${TRANSCRIPT} [data-boundary="relocation"]`;
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
/** Disabled for the whole of a turn — the turn-idle tell. */
const AI_CHIP_BUTTON = `${CARD} [data-slot="ai-chip"]`;
const BULLETIN = ".tug-pane-bulletin";

let dirA = "";
let dirB = "";

const claudeDir = (dir: string): string =>
  join(homedir(), ".claude", "projects", encodeProjectDir(dir));
const parentJsonl = (): string => join(claudeDir(dirA), `${PARENT_SID}.jsonl`);

/** The parent's history: one turn that plants the word. */
function seedParent(): void {
  mkdirSync(claudeDir(dirA), { recursive: true });
  const base = {
    isSidechain: false,
    userType: "external",
    cwd: dirA,
    sessionId: PARENT_SID,
    version: "2.1.105",
    gitBranch: "main",
  };
  const rows = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-000000065501",
      timestamp: new Date(Date.now() - 2000).toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: `Please remember the code word ${WORD}. I will ask for it later.` },
        ],
      },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000065501",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000065502",
      timestamp: new Date(Date.now() - 1000).toISOString(),
      message: {
        id: "msg-at0655-parent",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [{ type: "text", text: `Understood — the code word is ${WORD}.` }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 20 },
      },
    },
  ];
  writeFileSync(parentJsonl(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const lineCount = (path: string): number =>
  readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "").length;

beforeAll(() => {
  if (GATED_OFF) {
    note(
      "at0655 skipped",
      "real-claude only — run with TUG_REAL_CLAUDE=1 just app-test tests/app-test/at0655-change-directory-carries-context.test.ts",
    );
  }
  if (!SHOULD_RUN) return;
  dirA = realpathSync(mkdtempSync(join(tmpdir(), "at0655-A-")));
  dirB = realpathSync(mkdtempSync(join(tmpdir(), "at0655-B-")));
  seedParent();
});

afterAll(() => {
  for (const dir of [dirA, dirB]) {
    if (dir === "") continue;
    rmSync(dir, { recursive: true, force: true });
    rmSync(claudeDir(dir), { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
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

interface LineFacts {
  tugSessionId: string;
  projectDir: string;
}

const facts = (app: App): Promise<LineFacts> =>
  app.evalJS<LineFacts>(`window.__tug.cardLineFacts("A")`);

/**
 * Type `text` into the composer and submit it, past any completion popup.
 *
 * Mid-turn, Escape is Stop — it would cancel the very turn a refusal needs
 * in flight — so `idle: false` skips it and leaves the popup to the submit,
 * which accepts an active completion itself.
 */
async function submit(app: App, text: string, opts?: { idle?: boolean }): Promise<void> {
  await app.nativeClickAtElement(EDITOR);
  await app.nativeType(text);
  await new Promise((r) => setTimeout(r, 200));
  if (opts?.idle !== false) {
    await app.nativeKey("Escape");
    await new Promise((r) => setTimeout(r, 200));
  }
  await app.nativeKey("Return", ["cmd"]);
}

const chipIdle = `(() => {
  const chip = document.querySelector(${JSON.stringify(AI_CHIP_BUTTON)});
  return chip !== null && !chip.hasAttribute("disabled");
})()`;

/**
 * The carried turn, then the divider naming both directories — in that
 * document order. What a moved card shows before any new prompt.
 */
const carriedThenDivider = (): string => `(() => {
  const divider = document.querySelector(${JSON.stringify(DIVIDER)});
  if (divider === null) return false;
  const text = divider.textContent ?? "";
  if (!text.includes(${JSON.stringify(dirA)}) || !text.includes(${JSON.stringify(dirB)})) return false;
  // \`textContent\` reads in document order, and the word's rendering may span
  // several text nodes, so order is read off the transcript's whole text.
  const all = document.querySelector(${JSON.stringify(TRANSCRIPT)})?.textContent ?? "";
  const word = all.indexOf(${JSON.stringify(WORD)});
  return word !== -1 && word < all.indexOf(text);
})()`;

/** What the card's transcript holds, for a note when a wait goes wrong. */
const transcriptShape = (app: App): Promise<string> =>
  app.evalJS<string>(
    `JSON.stringify({
       boundaries: Array.from(document.querySelectorAll(${JSON.stringify(`${TRANSCRIPT} [data-boundary]`)}))
         .map((b) => b.getAttribute("data-boundary") + ": " + (b.textContent ?? "").slice(0, 200)),
       entries: document.querySelectorAll(${JSON.stringify(`${TRANSCRIPT} .tug-transcript-entry`)}).length,
       text: (document.querySelector(${JSON.stringify(TRANSCRIPT)})?.textContent ?? "").slice(0, 600),
     })`,
  );

describe.skipIf(!SHOULD_RUN)("AT0655: /cd carries the conversation", () => {
  test(
    "the move keeps the history, the fork runs in the new directory, and a mid-turn move is refused",
    async () => {
      const app = await launchTugApp({ testName: "at0655-change-directory-carries-context" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: PARENT_SID, projectDir: dirA });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });
        await app.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(TRANSCRIPT)})?.textContent ?? "").includes(${JSON.stringify(WORD)})`,
          { timeoutMs: 30_000 },
        );
        const parentLinesBefore = lineCount(parentJsonl());

        // ── The move ─────────────────────────────────────────────────────
        await submit(app, `/cd ${dirB}`);
        await app.waitForCondition<boolean>(
          `(() => { try {
             const f = window.__tug.cardLineFacts("A");
             return f.projectDir === ${JSON.stringify(dirB)} && f.tugSessionId !== ${JSON.stringify(PARENT_SID)};
           } catch { return false; } })()`,
          { timeoutMs: 60_000 },
        );
        const moved = await facts(app);
        note("at0655 the card after the move", JSON.stringify(moved));
        await app
          .waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(TRANSCRIPT)})?.textContent ?? "").includes(${JSON.stringify(WORD)})`,
            { timeoutMs: 30_000 },
          )
          .catch(() => false);
        note("at0655 the transcript after the move", await transcriptShape(app));
        await app.waitForCondition<boolean>(carriedThenDivider(), { timeoutMs: 60_000 });
        note("at0655 moved, before any new prompt", (await app.screenshot()).path);

        // ── A reload replays the parent, still pending ───────────────────
        //
        // The harness restores no bindings on its own (as at0216): the deck is
        // re-seeded and the card re-spawned on the moved session, in `B`, the
        // way the restore pass would. The fork's JSONL does not exist yet, so
        // tugcast derives the relocation from the ledger's fork edge and the
        // replay reads the parent's transcript from `A`.
        await app.appReload({ timeoutMs: 60_000 });
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: moved.tugSessionId, projectDir: dirB });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });
        const restored = await app
          .waitForCondition<boolean>(carriedThenDivider(), { timeoutMs: 60_000 })
          .then(() => true, () => false);
        note("at0655 the transcript after the reload", await transcriptShape(app));
        note(
          "at0655 the card after the reload",
          await app.evalJS<string>(
            `(() => { try { return JSON.stringify(window.__tug.cardLineFacts("A")); } catch (e) { return String(e); } })()`,
          ),
        );
        expect(restored, "the reload shows the carried turn, then the divider").toBe(true);
        expect((await facts(app)).tugSessionId, "the reload kept the moved session").toBe(
          moved.tugSessionId,
        );

        // ── The first turn in B: claude remembers, and runs in B ─────────
        await app.waitForCondition<boolean>(chipIdle, { timeoutMs: 60_000 });
        await submit(
          app,
          "What code word did I ask you to remember? Also state your current working directory as an absolute path.",
        );
        await app.waitForCondition<boolean>(
          `(() => {
             const entries = document.querySelectorAll(${JSON.stringify(`${TRANSCRIPT} .tug-transcript-entry`)});
             const last = entries[entries.length - 1];
             const text = last?.textContent ?? "";
             return text.includes(${JSON.stringify(WORD)}) && text.includes(${JSON.stringify(dirB)});
           })()`,
          { timeoutMs: 180_000 },
        );
        await app.waitForCondition<boolean>(chipIdle, { timeoutMs: 180_000 });

        // ── On disk: the fork is B's, the parent untouched ───────────────
        const forkJsonl = join(claudeDir(dirB), `${moved.tugSessionId}.jsonl`);
        expect(existsSync(forkJsonl), `the fork's JSONL is under B: ${forkJsonl}`).toBe(true);
        const cwds = readFileSync(forkJsonl, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => (JSON.parse(l) as { cwd?: string }).cwd)
          .filter((c): c is string => typeof c === "string");
        expect(cwds.length, "the fork's lines carry a cwd").toBeGreaterThan(0);
        expect(new Set(cwds), "every fork line runs in B").toEqual(new Set([dirB]));
        // The parent's own claude appends its session-state bookkeeping
        // (`mode`, `cost-state`, …) around its resume and exit. What the fork
        // must never do is write conversation into the parent: no new user or
        // assistant entry, and nothing under the fork's id or in `B`.
        const gained = readFileSync(parentJsonl(), "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .slice(parentLinesBefore)
          .map((l) => JSON.parse(l) as { type?: string; sessionId?: string; cwd?: string });
        note("at0655 lines the parent gained", gained.map((g) => g.type ?? "?").join(", "));
        expect(
          gained.filter((g) => g.type === "user" || g.type === "assistant"),
          "the parent's conversation is untouched",
        ).toEqual([]);
        expect(
          gained.filter((g) => g.sessionId === moved.tugSessionId || g.cwd === dirB),
          "nothing of the fork's is in the parent",
        ).toEqual([]);

        // ── Mid-turn, a move is refused ──────────────────────────────────
        await submit(app, "Count slowly from 1 to 60, one number per line.");
        await app.waitForCondition<boolean>(`!${chipIdle}`, { timeoutMs: 30_000 });
        await submit(app, `/cd ${dirA}`, { idle: false });
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(BULLETIN)}))
             .some((b) => (b.textContent ?? "").includes("Can't change the directory while a turn is in flight"))`,
          { timeoutMs: 15_000 },
        );
        expect((await facts(app)).projectDir, "the refused move left the card in B").toBe(dirB);
        await app.waitForCondition<boolean>(chipIdle, { timeoutMs: 180_000 });
        expect((await facts(app)).projectDir, "still in B after the turn").toBe(dirB);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

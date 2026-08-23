/**
 * at0192-z2-cold-replay.test.ts — the Z2 cold-replay vehicle ([AT0192]).
 *
 * ## Why this exists
 *
 * Z2's CONTEXT / MODEL readouts must reconstruct from the session
 * JSONL on a cold replay, independent of any durable side-table (which is
 * empty on a fresh target — see the per-instance-DB finding). The genuine
 * failure surface lives in the *delivery chain*: tugcode
 * `translateJsonlSession` → tugcast `CODE_OUTPUT → SESSION_METADATA` fan-out
 * → `CodeSessionStore` / `SessionMetadataStore`. A test that injects a
 * pre-cooked frame (`ingestFrame` / `ingestSessionMetadata`) bypasses that
 * chain and would go green while the real bug persists.
 *
 * So this vehicle drives the **real** chain end-to-end: it places a fixture
 * JSONL on disk where claude/tugcode expect it
 * (`~/.claude/projects/<encode(projectDir)>/<sessionId>.jsonl`), then fires a
 * genuine `spawn_session(mode=resume)` over the live connection via
 * `app.spawnSessionResume` (the production `sendSpawnSession` path). tugcast
 * spawns a real tugcode `--resume`; tugcode replays the JSONL (the live
 * Claude connect that follows is irrelevant — the replay emits first), and
 * the Z2 readouts populate from the replayed cost.
 *
 * This first case is the **cost-only smoke** — the already-correct path
 * (Steps 1–2 land per-turn cost on `turn_complete.telemetry.cost`). It proves
 * the vehicle itself works through the real chain: a fresh card, no synthetic
 * binding, no injected frame → a non-zero CONTEXT-used from
 * the fixture's `message.usage`. The model/CONTEXT-max + compaction-reset
 * assertions ride this same vehicle in later steps.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/code-session-store/
 * @covers tugdeck/src/lib/session-restore.ts
 * @covers tugdeck/src/lib/session-metadata-store.ts
 * @covers tugcode/
 * @covers tugdeck/src/components/tugways/cards/ai-chip.tsx
 * @covers tugdeck/src/lib/model-label.ts
 * @covers tugdeck/src/lib/model-context-max.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-renderers.tsx
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
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// A fixed, UUID-shaped claude/tug session id. The fixture JSONL is named
// `<SID>.jsonl`; the un-forked resume resolves the claude id to the tug
// session id (legacy fallback), so the two are identical here.
const SID = "a7c0d1ea-0000-4000-8000-00000000c0c0";

/**
 * Encode an absolute project dir the way claude names its per-project
 * subdir under `~/.claude/projects/` — mirrors tugcode's
 * `encodeProjectDir` (every character outside `[A-Za-z0-9-]` → `-`;
 * a `'/'`-only mapping breaks the fixture path the moment the resolved
 * project dir carries a dot or underscore, e.g. a `.tugtree` worktree).
 * Kept inline so the app-test graph does not import tugcode.
 */
const encodeProjectDir = (absDir: string): string =>
  absDir.replace(/[^A-Za-z0-9-]/g, "-");

// The cost-only smoke fixture: two clean turns, each carrying `message.usage`
// and a real `message.model`. The last turn's resident window is
// 1500 + 80 + 12000 + 200 = 13_780 (CONTEXT-used) — non-zero.
//
// The lines carry claude's own session-JSONL fields (`uuid` / `parentUuid`
// chain, `sessionId`, `cwd`, `version`, `gitBranch`, …) — not just the subset
// tugcode's `translateJsonlSession` reads — because `claude --resume <id>`
// reads the SAME file: a thin fixture parses for tugcode but makes claude
// report "No conversation found" and `resume_failed`, which reverts the card
// to the picker before the replayed Z2 can stick. `cwd` must equal the
// resolved project dir, so the fixture is built per-run.
function buildFixtureJsonl(cwd: string, sessionId: string): string {
  const base = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.105",
    gitBranch: "main",
  };
  const lines = [
    {
      ...base,
      parentUuid: null,
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000c01",
      timestamp: "2026-06-17T10:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000000c01",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000c02",
      timestamp: "2026-06-17T10:00:01.000Z",
      message: {
        id: "msg-cold-1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
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
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000000c02",
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000c03",
      timestamp: "2026-06-17T10:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "more please" }] },
    },
    {
      ...base,
      parentUuid: "00000000-0000-4000-8000-000000000c03",
      type: "assistant",
      uuid: "00000000-0000-4000-8000-000000000c04",
      timestamp: "2026-06-17T10:01:02.000Z",
      message: {
        id: "msg-cold-2",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "sure thing" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 1500,
          output_tokens: 80,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 12000,
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
  // Resolve the temp dir's realpath: macOS `mkdtemp` returns `/var/folders/…`,
  // but tugcode (and claude) resolve `/var` → `/private/var` before encoding
  // the claude-projects subdir. We must encode + spawn against the SAME
  // resolved string, or the fixture lands at a path neither reads (the
  // 0-bytes-replayed bug). `realpathSync` gives the resolved form.
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0192-proj-")));
  fixtureDir = join(homedir(), ".claude", "projects", encodeProjectDir(projectDir));
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, `${SID}.jsonl`),
    buildFixtureJsonl(projectDir, SID),
  );
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
  // Remove only the unique per-test encoded subdir we created — never the
  // user's real sessions.
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

describe.skipIf(!SHOULD_RUN)(
  "AT0192: Z2 reconstructs from a real cold replay (cost-only smoke)",
  () => {
    test(
      "real spawn_session(resume) replays the fixture JSONL → non-zero CONTEXT-used and the shipped Z2 lineup",
      async () => {
        const app = await launchTugApp({ testName: "at0192-z2-cold-replay" });

        // Status-row cell readers. The cells are `TugStatusCell`s keyed by
        // `data-priority`; the CONTEXT value splits into a numerator
        // (resident window = used) and a denominator (`/ <max>` from the
        // resolved model).
        const CTX_USED_JS = `(() => {
          const el = document.querySelector('[data-card-id="A"] [data-slot="tug-status-cell"][data-priority="context"] .session-telemetry-status-context-numerator');
          return el ? (el.textContent || '').trim() : '';
        })()`;
        const CTX_MAX_JS = `(() => {
          const el = document.querySelector('[data-card-id="A"] [data-slot="tug-status-cell"][data-priority="context"] .session-telemetry-status-context-denominator');
          return el ? (el.textContent || '').trim() : '';
        })()`;
        // The row's shipped lineup, in DOM order, alongside whether each
        // cell is actually laid out. A cell hidden by a `@container`
        // collapse rung has no `offsetParent`, so a rung that fires at a
        // width meant to show everything is caught here rather than by eye.
        const LINEUP_JS = `(() => {
          const cells = document.querySelectorAll('[data-card-id="A"] [data-slot="tug-status-cell"]');
          return Array.from(cells).map((el) => ({
            priority: el.getAttribute('data-priority'),
            shown: el.offsetParent !== null,
          }));
        })()`;
        // The AI chip's ACTIVE composite value (the visible variant; alternates
        // are aria-hidden width sizers), split into its `model · effort · mode`
        // tokens. Effort is OMITTED rather than dashed when unsupported, so the
        // token COUNT is what says whether a level is known.
        const AI_TOKENS_JS = `(() => {
          const el = document.querySelector('[data-card-id="A"] [data-slot="ai-chip"] [data-slot="ai-chip-value"]');
          return el ? (el.textContent || '').trim().split(" \\u00b7 ") : [];
        })()`;

        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 15_000 },
          );

          // Fire the REAL spawn_session(resume). No synthetic binding, no
          // injected frame — tugcast spawns a real tugcode that replays the
          // fixture JSONL through the live delivery chain. The replay lands
          // sub-second; the timeout only covers tugcode spawn + claude's
          // resume settling.
          await app.spawnSessionResume("A", { tugSessionId: SID, projectDir });

          // Wait for the replayed cost to land: the CONTEXT-used numerator
          // renders the last turn's resident window from the fixture usage.
          await app.waitForCondition<boolean>(
            `(() => {
              const t = ${CTX_USED_JS};
              return t.length > 0 && /[1-9]/.test(t);
            })()`,
            { timeoutMs: 15_000 },
          );

          const ctxUsed = await app.evalJS<string>(CTX_USED_JS);
          const ctxMax = await app.evalJS<string>(CTX_MAX_JS);

          // CONTEXT-used = window(last) of the replayed usage — non-zero, not
          // the "0" empty-resident reading. This is the primary proof the
          // replayed cost reached the store through the real chain.
          expect(ctxUsed).not.toBe("");
          expect(/[1-9]/.test(ctxUsed)).toBe(true);

          // The shipped lineup: five cells, left to right, all laid out.
          // The retired TOKENS cell and the merged WORK cell are gone;
          // TASKS and JOBS stand in their place.
          const lineup = await app.evalJS<
            Array<{ priority: string; shown: boolean }>
          >(LINEUP_JS);
          expect(lineup.map((c) => c.priority)).toEqual([
            "state",
            "time",
            "context",
            "tasks",
            "jobs",
          ]);
          expect(lineup.every((c) => c.shown)).toBe(true);

          // Active-model delivery (#step-7): the replayed `claude-opus-5`
          // reaches the metadata store through the SESSION_SIDEBAND feed and
          // survives both the multiplex (the per-kind replay cache stops the
          // later `session_capabilities` frame from shadowing the model frame)
          // and the empty-model live re-init that follows ([P06] no-clobber),
          // so the CONTEXT denominator resolves to opus-5's native 1M window
          // — NOT the 200K unknown-model default the pre-fix path showed.
          //
          // The fixture names the CURRENT generation on purpose, and names it
          // BARE: claude's JSONL records `claude-opus-5` with no `[1m]`, and
          // this cold replay has no catalog to consult, so the denominator
          // rests entirely on the family/version floor in
          // [model-context-max.ts]. An exact-id table (what that module used
          // to be) reads 200K here the day a new model ships.
          const aiTokens = await app.evalJS<string[]>(AI_TOKENS_JS);
          const modelText = aiTokens[0] ?? "";
          expect(ctxMax).not.toBe("");
          expect(ctxMax.includes("200")).toBe(false);
          expect(ctxMax.includes("1.0") || ctxMax.includes("1M")).toBe(true);
          expect(modelText.includes("?")).toBe(false);

          // EFFORT: effort support resolves from real data only — the live
          // handshake or the PERSISTED model catalog. This cold replay has
          // neither (a fresh test instance, no session ever reported
          // capabilities), so support is genuinely unknowable and the composite
          // OMITS the effort token rather than inventing a level from a
          // hardcoded list — leaving `model · mode`, two tokens. A machine that
          // resumes for real has the prior session's persisted catalog and shows
          // the level, giving three.
          expect(aiTokens.length, "model · mode, with no effort token").toBe(2);

          process.stdout.write(
            `[at0192] CONTEXT ${ctxUsed} ${ctxMax} · CELLS ${lineup.map((c) => c.priority).join("/")} · AI ${aiTokens.join(" · ")}\n`,
          );
          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          // Capture the tugdeck-side state to localize the break: did the
          // card bind (picker→body)? did a spawn error fire? does the status
          // row exist? what do the cells read?
          const DIAG_JS = `JSON.stringify((() => {
            const card = document.querySelector('[data-card-id="A"]');
            const q = (sel) => !!(card && card.querySelector(sel));
            const txt = (sel) => {
              const el = card && card.querySelector(sel);
              return el ? (el.textContent || '').trim() : null;
            };
            return {
              hasCard: !!card,
              picker: q('[data-slot="session-card-picker"]'),
              restoring: q('[data-slot="session-card-restoring"]'),
              body: q('[data-slot="session-card"]'),
              statusBar: q('[data-slot="session-card-status-bar"]'),
              statusRow: q('[data-slot="session-telemetry-status-row"]'),
              spawnError: q('[data-testid="session-card-spawn-error-retry"]'),
              ctxUsed: txt('[data-priority="context"] .session-telemetry-status-context-numerator'),
              ctxMax: txt('[data-priority="context"] .session-telemetry-status-context-denominator'),
              tasks: txt('[data-priority="tasks"] .tug-progress-indicator-label-active'),
              jobs: txt('[data-priority="jobs"] .tug-progress-indicator-label-active'),
              ai: txt('[data-slot="ai-chip-value"]'),
              cardHtmlHead: card ? (card.outerHTML || '').slice(0, 1200) : null,
            };
          })())`;
          try {
            const diag = await app.evalJS<string>(DIAG_JS);
            process.stderr.write(`\n[at0192] tugdeck state:\n${diag}\n`);
          } catch (probeErr) {
            process.stderr.write(`\n[at0192] diag probe failed: ${String(probeErr)}\n`);
          }
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0192] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/**
 * at0869-busy-card-yields-to-latch.test.ts — a card that slept through its
 * turn's end, and whose catch-up never answers, comes back idle because
 * tugcast's turn latch says the turn is over ([AT0869]).
 *
 * ## Why this exists
 *
 * A card went dormant mid-turn, the turn ended while it slept, and the
 * catch-up its reveal asked was never answered. The card kept believing the
 * turn was running: Stop stayed on offer, the join offer held behind
 * `turn-in-flight`, and nothing would ever correct it, because the frame
 * that ends a turn was the only thing that could. tugcast's per-session
 * latch already knew better. The card now yields to it: once a catch-up
 * closes with the cycle still standing and the latch reading idle for that
 * turn, the cycle is dropped, the card goes idle, and one
 * `turn reconciled` line is written to `tugcast.log`.
 *
 * ## How
 *
 * A stub session (`tugcode/src/stub-replay.ts`) plays one paced turn and
 * answers no catch-up (`answersCatchUp: false`). The card sends the turn,
 * is put away on another space until it goes dormant, and the turn finishes
 * while it sleeps. Shown again, its catch-up goes unanswered and lapses at
 * the five-second deadline; the card must be idle, with `canInterrupt`
 * false, as soon as it does. The follow-up catch-up the correction asks is
 * not waited out.
 *
 * @covers tugdeck/src/lib/code-session-store/turn-reconcile.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/body/body-turn-latch.ts
 * @covers tugdeck/src/lib/body-arrangement.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type TugcodeTranscript } from "./_harness";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";
import { bodyOf, pollFor, promptPhase, sessionPane, waitForBody } from "./body-grounding/_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "at0869-a";
/** The body's delay before dormancy, shortened from five minutes. */
const DORMANT_AFTER_MS = 300;
/** Milliseconds between one stub output and the next. */
const PACE_MS = 250;
/** Deltas in the turn: long enough to still be streaming when the card goes dormant. */
const DELTAS = 10;
/** The card's catch-up deadline (`CATCH_UP_DEADLINE_MS`), plus room for the lapse to land. */
const LAPSE_WAIT_MS = 5_000 + 3_000;
const IPC_VERSION = 2;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** One paced turn, and no answer to any catch-up. */
function transcript(): TugcodeTranscript {
  const outputs: unknown[] = [
    { type: "content_block_start", msg_id: "stub-turn", block_index: 0, kind: "text", ipc_version: IPC_VERSION },
  ];
  for (let i = 0; i < DELTAS; i++) {
    outputs.push({ type: "assistant_text", msg_id: "stub-turn", block_index: 0, seq: 0, rev: i, text: `word${i} `, is_partial: true, status: "partial", ipc_version: IPC_VERSION });
  }
  outputs.push(
    { type: "assistant_text", msg_id: "stub-turn", block_index: 0, seq: 0, rev: DELTAS, text: "done", is_partial: false, status: "complete", ipc_version: IPC_VERSION },
    { type: "turn_complete", msg_id: "stub-turn", seq: 1, result: "success", ipc_version: IPC_VERSION },
  );
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    paceMs: PACE_MS,
    answersCatchUp: false,
    turns: [{ index: 0, description: "a turn that ends while the card sleeps", outputs }],
  } as TugcodeTranscript;
}

interface Facts {
  phase: string;
  canInterrupt: boolean;
  catchingUp: boolean;
  activeTurnKey: string | null;
}

/** In the body: its dormancy, the prompt entry's phase, and the store's belief about its turn. */
const READ = `(function () {
  return {
    dormant: window.__tug.bodyDormancy().dormant,
    prompt: ${promptPhase},
    facts: window.__tug.turnFacts(${JSON.stringify(A)}),
  };
})()`;

interface Read {
  dormant: boolean;
  prompt: string | null;
  facts: Facts;
}

/** The instance's `tugcast.log` lines about turn reconciles and catch-ups, ANSI stripped. */
function logLines(instanceId: string): string[] {
  const logs = join(homedir(), "Library/Application Support/Tug/instances", instanceId, "Logs");
  const file = existsSync(logs) ? readdirSync(logs).find((f) => f.startsWith("tugcast.log")) : undefined;
  if (file === undefined) return [];
  return readFileSync(join(logs, file), "utf8")
    // oxlint-disable-next-line no-control-regex -- strips the log's ANSI colour codes, which begin with ESC
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((l) => /turn reconciled|turn-reconcile|catch-up/.test(l));
}

describe.skipIf(!SHOULD_RUN)("AT0869: a busy card yields to tugcast's latch", () => {
  test(
    "a card whose catch-up never answers comes back idle, Stop withdrawn, with one reconcile line",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "at0869-busy-card-yields-to-latch", env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0869-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript()));
        await app.spawnSessionNew(A, { tugSessionId, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);
        await app.bodyDelays({ dormantAfterMs: DORMANT_AFTER_MS });
        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 10_000 });

        // ---- The turn opens on the card ----
        const sentAt = Date.now();
        await body.driveSession({ op: "send", text: "A turn the card will sleep through." });
        const busy = await pollFor(() => body.evalJS<Read>(READ), (r) => r.facts.canInterrupt, 5_000);
        expect(busy.facts.canInterrupt, "the card offers Stop while its turn runs").toBe(true);

        // ---- Put away mid-turn: the card sleeps ----
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.createSpace(), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        const slept = await pollFor(() => body.evalJS<Read>(READ), (r) => r.dormant, 5_000);
        expect(slept.dormant, "the hidden card went dormant").toBe(true);
        expect(slept.facts.canInterrupt, "it went to sleep believing its turn runs").toBe(true);

        // ---- The turn ends while it sleeps ----
        await Bun.sleep(Math.max(0, sentAt + (DELTAS + 3) * PACE_MS + 500 - Date.now()));
        const asleep = await body.evalJS<Read>(READ);
        note(`asleep after the turn ended: ${JSON.stringify(asleep)}`);
        expect(asleep, "the sleeping card never heard the turn end").toMatchObject({ dormant: true, facts: { canInterrupt: true } });

        // ---- Shown again: the catch-up goes unanswered, lapses, and the card yields ----
        const revealAt = Date.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === true, 5_000);
        // The body leaves dormant only when its catch-up closes, and the
        // correction asks a follow-up at once, so it reads dormant until that
        // one closes too. The card's own belief is what is asserted, as soon
        // as it yields.
        const healed = await pollFor(
          () => body.evalJS<Read>(READ),
          (r) => r.facts.phase === "idle",
          LAPSE_WAIT_MS,
        );
        note(`idle ${Date.now() - revealAt} ms after the switch: ${JSON.stringify(healed)}`);
        expect(healed, "the card yielded to the latch: idle, Stop withdrawn").toMatchObject({
          prompt: "idle",
          facts: { phase: "idle", canInterrupt: false, activeTurnKey: null, catchingUp: true },
        });

        // ---- And said so, once, in tugcast.log ----
        const lines = await pollFor(
          async () => logLines(app.instanceId),
          (ls) => ls.some((l) => l.includes("turn reconciled")),
          3_000,
        );
        note(`tugcast: ${lines.map((l) => l.slice(0, 260)).join(" | ")}`);
        const reconciled = lines.filter((l) => l.includes("turn reconciled"));
        expect(reconciled, "one turn reconciled line").toHaveLength(1);
        expect(reconciled[0]).toContain("turn-reconcile");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

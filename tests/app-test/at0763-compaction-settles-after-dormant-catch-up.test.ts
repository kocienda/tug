/**
 * at0763-compaction-settles-after-dormant-catch-up.test.ts — a `/compact`
 * that finished while its card slept brings the Compacting cover and its
 * scrim down the moment the card is shown again, while the turn after it is
 * still running ([AT0763]).
 *
 * ## Why this exists
 *
 * The wheel sent a seated stage `/compact`; the card was on another space,
 * went dormant mid-compaction, and heard nothing more. The compaction ended,
 * the wheel's next prompt opened the next turn, and when the card was shown
 * its catch-up delivered both in one bracket — one notify, showing a live
 * turn. The run's old watcher settled only on an active → idle edge it had to
 * see, so the cover stood over a working card until that next turn ended. The
 * run now settles from what the snapshot holds: the compact turn, committed
 * with its compaction mark.
 *
 * ## How
 *
 * A stub session (`tugcode/src/stub-replay.ts`) plays three turns: a short
 * one heard whole, the `/compact` (its boundary, its summary, its end), and a
 * long streaming turn. The wheel's `/compact` is announced to the card as
 * tugcast announces it — a `tug_notice` from the wheel, which opens the run
 * and raises the cover — and both prompts reach the session from outside the
 * card while it sleeps, as the wheel's do. Shown again, the body's catch-up
 * brings back the compact turn committed and the long one as the bracket's
 * snapshot, and the cover must be down while that turn still streams.
 *
 * @covers tugdeck/src/components/tugways/cards/session-compaction-run.tsx
 * @covers tugdeck/src/lib/compaction-progress-store.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, TUGCODE_TRANSCRIPT_SCHEMA_VERSION, type TugcodeTranscript } from "./_harness";
import { onTestRunEnd } from "./_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "./streaming-stub-fixture";
import { bodyOf, pollFor, promptPhase, sessionPane, waitForBody } from "./body-grounding/_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "at0763-a";
/** The body's delay before dormancy, shortened from five minutes. */
const DORMANT_AFTER_MS = 300;
/** Milliseconds between one stub output and the next. */
const PACE_MS = 400;
/** Deltas in the turn after the compaction: long enough to still be streaming at the reveal. */
const NEXT_TURN_DELTAS = 20;
const IPC_VERSION = 2;
const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";
const COVER = '[data-slot="compaction-progress"]';
const RESUME_PROMPT = "/tugplug:arc-implement demo resume Step 5";

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** The short first turn, the `/compact`, and a long streaming turn. */
function transcript(): TugcodeTranscript {
  const text = (msgId: string, body: string, seq: number): unknown[] => [
    { type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text", ipc_version: IPC_VERSION },
    { type: "assistant_text", msg_id: msgId, block_index: 0, seq, rev: 0, text: body, is_partial: false, status: "complete", ipc_version: IPC_VERSION },
  ];
  const next: unknown[] = [
    { type: "content_block_start", msg_id: "stub-next", block_index: 0, kind: "text", ipc_version: IPC_VERSION },
  ];
  for (let i = 0; i < NEXT_TURN_DELTAS; i++) {
    next.push({ type: "assistant_text", msg_id: "stub-next", block_index: 0, seq: 1, rev: i, text: `word${i} `, is_partial: true, status: "partial", ipc_version: IPC_VERSION });
  }
  next.push(
    { type: "assistant_text", msg_id: "stub-next", block_index: 0, seq: 1, rev: NEXT_TURN_DELTAS, text: "resumed", is_partial: false, status: "complete", ipc_version: IPC_VERSION },
    { type: "turn_complete", msg_id: "stub-next", seq: 2, result: "success", ipc_version: IPC_VERSION },
  );
  return {
    schemaVersion: TUGCODE_TRANSCRIPT_SCHEMA_VERSION,
    tugcodeVersion: "stub",
    paceMs: PACE_MS,
    turns: [
      { index: 0, description: "a short turn, heard whole", outputs: [...text("stub-first", "first", 0), { type: "turn_complete", msg_id: "stub-first", seq: 0, result: "success", ipc_version: IPC_VERSION }] },
      {
        index: 1,
        description: "the /compact",
        outputs: [
          { type: "compact_boundary", trigger: "manual", pre_tokens: 605_470, post_tokens: 9_205, ipc_version: IPC_VERSION },
          { type: "compact_summary", summary: "carry-forward summary", ipc_version: IPC_VERSION },
          { type: "turn_complete", msg_id: "stub-compact", seq: 1, result: "success", ipc_version: IPC_VERSION },
        ],
      },
      { index: 2, description: "the turn after the compaction, streaming at the reveal", outputs: next },
    ],
  } as TugcodeTranscript;
}

/** In the body: its dormancy, the prompt phase, and the run's two faces of the hold — the cover and the pane's scrim. */
const READ = `(function () {
  return {
    dormant: window.__tug.bodyDormancy().dormant,
    phase: ${promptPhase},
    cover: document.querySelector(${JSON.stringify(COVER)}) !== null,
    scrim: document.querySelector("[data-scrim]") !== null,
    divider: document.querySelector('[data-boundary="compaction"]') !== null,
  };
})()`;

interface Read {
  dormant: boolean;
  phase: string | null;
  cover: boolean;
  scrim: boolean;
  divider: boolean;
}

describe.skipIf(!SHOULD_RUN)("AT0763: a compaction a dormant card slept through settles at the reveal", () => {
  test(
    "the cover and scrim are down once the catch-up lands, while the next turn still streams",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "at0763-compaction-settles-after-dormant-catch-up", env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-at0763-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(transcript()));
        await app.spawnSessionNew(A, { tugSessionId, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);
        await app.bodyDelays({ dormantAfterMs: DORMANT_AFTER_MS });
        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 10_000 });

        // ---- History: one turn, heard whole ----
        await body.driveSession({ op: "send", text: "The first turn." });
        const heard = await pollFor(() => body.evalJS<Read>(READ), (r) => r.phase === "idle", 10_000);
        expect(heard.phase, "the first turn ended").toBe("idle");

        // ---- The wheel's /compact, announced: the run opens and the cover rises ----
        await body.driveSession({
          op: "ingestFrame",
          feedId: CODE_OUTPUT_FEED,
          decoded: { type: "tug_notice", tug_session_id: tugSessionId, origin: "wheel", text: "/compact" },
        });
        const raised = await pollFor(() => body.evalJS<Read>(READ), (r) => r.cover && r.scrim, 8_000);
        expect(raised, "the wheel's /compact opened the run and raised its cover").toMatchObject({ cover: true, scrim: true });

        // ---- The card is put away and sleeps before the compaction runs ----
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        const slept = await pollFor(() => body.evalJS<Read>(READ), (r) => r.dormant, 5_000);
        expect(slept.dormant, "the hidden card went dormant").toBe(true);

        // ---- Asleep: the compaction and the wheel's next prompt reach the session from outside ----
        const sentAt = Date.now();
        await body.driveSession({ op: "promptElsewhere", text: "/compact" });
        await body.driveSession({ op: "promptElsewhere", text: RESUME_PROMPT });
        // Show the card once the compaction has ended and the next turn is under way.
        await Bun.sleep(Math.max(0, sentAt + 4 * PACE_MS + 600 - Date.now()));
        const asleep = await body.evalJS<Read>(READ);
        note(`asleep: ${JSON.stringify(asleep)} ${JSON.stringify(await body.evalJS<unknown>(`window.__tug.compactionRunFacts(${JSON.stringify(A)})`))}`);
        expect(asleep, "the sleeping card still shows the run it went to sleep under").toMatchObject({ dormant: true, cover: true });

        // ---- Shown again: the catch-up lands the compaction, and the run settles ----
        const revealAt = Date.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        // What the session holds at each look until the run settles, so a late
        // settle says why: the catch-up still standing, the compact turn not
        // committed or not marked, or the run looking for the wrong turn.
        const FACTS = `window.__tug.compactionRunFacts(${JSON.stringify(A)})`;
        let caughtUp: { ms: number; facts: unknown } | null = null;
        const settled = await pollFor(
          async () => {
            const r = await body.evalJS<Read>(READ);
            if (caughtUp === null && !r.dormant) {
              const facts = await body.evalJS<{ catchingUp: boolean }>(FACTS);
              if (!facts.catchingUp) caughtUp = { ms: Date.now() - revealAt, facts };
            }
            return r;
          },
          (r) => !r.dormant && !r.cover && !r.scrim,
          8_000,
        );
        note(`caught up: ${JSON.stringify(caughtUp)}`);
        note(`at settle: ${JSON.stringify(await body.evalJS<unknown>(FACTS))}`);
        note(`settled ${Date.now() - revealAt} ms after the switch: ${JSON.stringify(settled)}`);
        expect(settled, "the cover and scrim came down while the turn after the compaction was still running").toMatchObject({
          dormant: false,
          phase: "streaming",
          cover: false,
          scrim: false,
          divider: true,
        });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

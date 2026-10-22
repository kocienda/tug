/**
 * row-35-dormancy-lineage.test.ts — a card that holds turns its session does
 * not count catches up on exactly the turns it missed.
 *
 * A card bound to an arc's stage, or to a relocated session, holds the
 * lineage's earlier turns above its own session's: its transcript counts
 * every one of them, while tugcode counts turns in the resumed session's own
 * coordinates. Here the card's session runs one turn, and the card is then
 * given the restore a lineage replay makes: two ancestor turns, a stage
 * divider, then that turn. Its session streams a second turn; its workspace
 * is parked, the body goes dormant past its delay, and the second turn ends
 * while it sleeps. Shown again, the catch-up must bring that turn's end in —
 * which an index reconstructed from the card's count overshoots, by the two
 * turns its session never held, into an empty bracket — and must not bring a
 * turn the card already holds back a second time.
 *
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/body/body-dormancy.ts
 * @covers tugcode/src/stub-replay.ts
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note } from "../_harness";
import { onTestRunEnd } from "../_harness/test-cleanup";
import { STUB_TRANSCRIPT_DIR_ENV, STREAM_PACE_MS, stubDirectory, streamingTranscript } from "../streaming-stub-fixture";
import { bodyOf, pollFor, settleFor, promptPhase, sessionPane, waitForBody } from "./_bodies";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const A = "r35l-a";
const CODE_OUTPUT_FEED = 0x40;
/** The body's delay before dormancy, shortened from a minute for the row. */
const DORMANT_AFTER_MS = 800;
/** The lineage's turns the card is handed before its own session's. */
const ANCESTOR_TURNS = 2;
/** The last words of the second turn: present only once its end has reached the page. */
const MARKER = "lineage-turn-ends-here";
const WORDS_PER_MESSAGE = 70;
const MESSAGES = 2;
/** How long the second turn streams, at the stub's pace (a delta a word). */
const TURN_MS = WORDS_PER_MESSAGE * MESSAGES * STREAM_PACE_MS;
const ACTIVE_SPACE = "window.tugdeck.diag.getSpaces().activeSpaceId";

/** The first turn's messages are a word each; the second's are long, and its last ends with the marker. */
function text(index: number): string {
  if (index < MESSAGES) return `firstturn-${index}`;
  const words = Array.from({ length: WORDS_PER_MESSAGE - 1 }, (_, i) => `word${index}-${i}`).join(" ");
  return index === 2 * MESSAGES - 1 ? `${words} ${MARKER}` : words;
}

function deck(): Record<string, unknown> {
  return {
    cards: [{ id: A, componentId: "session", title: "A", closable: true }],
    panes: [sessionPane(A, 0)],
    activePaneId: `${A}-pane`,
    imposition: { kind: "one-up", layout: "fit", sidebars: {} },
    hasFocus: true,
  };
}

/** How often `needle` appears in the transcript's text. */
const countOf = (needle: string): string =>
  `((document.querySelector('[data-testid="session-card-transcript"]') || {}).textContent || "").split(${JSON.stringify(needle)}).length - 1`;

/** In the body: its dormancy, its prompt phase, and how often each turn's words appear. */
const READ = `(function () {
  var d = window.__tug.bodyDormancy();
  return { dormant: d.dormant, shown: d.shown, phase: ${promptPhase}, ended: ${countOf(MARKER)}, first: ${countOf("firstturn-1")}, ancestor: ${countOf("ancestor reply 1")} };
})()`;

interface Read {
  dormant: boolean;
  shown: boolean;
  phase: string | null;
  ended: number;
  first: number;
  ancestor: number;
}

describe.skipIf(!SHOULD_RUN)("body-grounding row 35: a lineage card's catch-up", () => {
  test(
    "a card holding turns its session does not count catches up on exactly what it missed",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "body-grounding-row-35-dormancy-lineage", env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: deck(), focusCardId: A });
        const tugSessionId = randomUUID();
        const projectDir = realpathSync(mkdtempSync(join(tmpdir(), "tug-r35l-project-")));
        onTestRunEnd(() => rmSync(projectDir, { recursive: true, force: true }));
        writeFileSync(join(stubDir, `${tugSessionId}.json`), JSON.stringify(streamingTranscript(MESSAGES, 2, text)));
        await app.spawnSessionNew(A, { tugSessionId, projectDir });
        await waitForBody(app, A);
        const body = app.body(A);
        await app.bodyDelays({ dormantAfterMs: DORMANT_AFTER_MS });
        await body.waitForCondition<boolean>(`${promptPhase} === "idle"`, { timeoutMs: 10_000 });

        // ---- The session's own first turn, heard whole ----
        await body.driveSession({ op: "send", text: "The first turn." });
        const heard = await settleFor(() => body.evalJS<Read>(READ), (r) => r.first === 1 && r.phase === "idle", 10_000);
        expect(heard, "the session's own first turn is in").toMatchObject({ first: 1, phase: "idle" });

        // ---- The restore a lineage replay makes: the ancestors' turns, then the session's ----
        const ingest = (decoded: Record<string, unknown>): Promise<void> =>
          body.driveSession({ op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded: { tug_session_id: tugSessionId, ...decoded } });
        await ingest({ type: "replay_started" });
        for (let i = 0; i < ANCESTOR_TURNS; i++) {
          await ingest({ type: "add_user_message", content: [{ type: "text", text: `ancestor prompt ${i}` }] });
          await ingest({ type: "assistant_text", seq: 0, rev: 0, status: "complete", msg_id: `anc-${i}`, block_index: 0, text: `ancestor reply ${i}`, is_partial: false });
          await ingest({ type: "turn_complete", seq: 0, msg_id: `anc-${i}`, result: "success" });
        }
        await ingest({ type: "replay_stage", stage: "implement", model: "opus", arc: "r35l" });
        await ingest({ type: "add_user_message", content: [{ type: "text", text: "The first turn." }] });
        for (let m = 0; m < MESSAGES; m++) {
          await ingest({ type: "assistant_text", seq: m, rev: 0, status: "complete", msg_id: `stub-msg-${m}`, block_index: 0, text: text(m), is_partial: false });
        }
        await ingest({ type: "turn_complete", seq: MESSAGES, msg_id: `stub-msg-${MESSAGES - 1}`, result: "success" });
        await ingest({ type: "replay_complete", count: ANCESTOR_TURNS + 1 });
        const restored = await settleFor(() => body.evalJS<Read>(READ), (r) => r.ancestor === 1 && r.first === 1 && r.phase === "idle", 5_000);
        expect(restored, "the card holds the lineage's turns and the session's first, each once").toMatchObject({ ancestor: 1, first: 1, phase: "idle" });

        // ---- The second streams; the workspace is parked under it ----
        await body.driveSession({ op: "send", text: "Stream the second turn." });
        await body.waitForCondition<boolean>(`${promptPhase} === "streaming"`, { timeoutMs: 10_000 });
        const streamingAt = Date.now();
        const home = await app.evalJS<string>(ACTIVE_SPACE);
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("new-space"), null)`);
        await pollFor(() => app.evalJS<string>(ACTIVE_SPACE), (id) => id !== home, 5_000);
        await pollFor(() => bodyOf(app, A), (b) => b?.shown === false, 5_000);
        const asleep = await settleFor(() => body.evalJS<Read>(READ), (r) => r.dormant, 5_000);
        expect(asleep, "the hidden body is dormant past its delay, the second turn still running").toMatchObject({ dormant: true, ended: 0 });
        await Bun.sleep(Math.max(0, streamingAt + TURN_MS + 1_000 - Date.now()));
        const unheard = await body.evalJS<Read>(READ);
        expect(unheard.ended, "the second turn's end, sent while the body slept, never reached it").toBe(0);

        // ---- Shown again: it catches up on the second turn, and on nothing else ----
        const revealAt = Date.now();
        await app.evalJS<null>(`(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`);
        const caught = await settleFor(
          () => body.evalJS<Read>(READ),
          (r) => !r.dormant && r.ended > 0 && r.phase === "idle",
          10_000,
        );
        note(`caught up ${Date.now() - revealAt} ms after the switch: ${JSON.stringify(caught)}`);
        expect(caught, "the revealed body holds the second turn's end once, and every turn it held before once").toMatchObject({
          dormant: false,
          phase: "idle",
          ended: 1,
          first: 1,
          ancestor: 1,
        });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

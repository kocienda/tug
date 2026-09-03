/**
 * at0507-arc-note-quiet-row.test.ts — an arc gesture's derived line renders
 * as a quiet line, not as an exchange entry.
 *
 * The arc-note rows ([P12]) are `$`-route exchanges the server derives from
 * the arc log — nobody typed them and no process ran. Their first
 * fully-instrumented run rendered each one as a full transcript entry: a
 * `Wheel` participant header with timestamp • cwd, a `#s{n}` address, a
 * command block, and an output panel — three stacked exchange blocks
 * announcing processes that never ran, for three one-sentence facts. The
 * registration now declares `presentation: "quiet"`, and `ShellTurnCell`
 * renders a claimed quiet row as the sentence alone.
 *
 * Assertions, in the order the two seats are exercised:
 *
 *  1. **Between turns** (the restore path's shape): an arc-note exchange
 *     paints the quiet row (`session-transcript-quiet-row`) carrying the
 *     sentence, with none of the entry scaffolding (no participant header,
 *     no address badge, no exit end-state); an ordinary shell exchange
 *     beside it keeps its full entry row.
 *  2. **Inside the open turn** (the live path): an `arcNote` delivered while
 *     a turn is streaming seats as a `source: "arc"` system_note IN that
 *     turn — the `arc-note` quiet line renders within the turn's transcript
 *     entry, between the work it narrates and the turn's end, and no new
 *     between-turns quiet row appears. This is what makes an arc read as
 *     one conversation instead of a pile of misfiled rows.
 *  3. **After the turn commits** (the relaunch order): the same gesture
 *     re-arriving as a shell-ledger row whose wall-clock falls inside a
 *     committed turn's span is ABSORBED into that turn (`absorbArcNotes`)
 *     rather than seated as a row of its own — a reopened session reads
 *     exactly as the live one did. The live seat from (2) survives the
 *     turn's commit, and the ledger replay of that same note (same
 *     exchangeId) dedups instead of doubling.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-note-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-command-block-registry.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "test-session-A";
const CARD = `[data-card-id="A"]`;

/** The sentence `note_for_line` would derive — the row's entire payload. */
const SENTENCE = "demo: step 1/3 started — carve the first slice";
/** Seat 2's sentence, distinct so the two asserts cannot shadow each other. */
const MID_TURN_SENTENCE = "demo: step 1/3 closed (9969b1e81)";
/** Seat 3's sentence — the ledger row absorbed after the turn committed. */
const RESTORED_SENTENCE = "demo: round 0ae618a02 — remove the wiring";
/** `FeedId.CODE_OUTPUT` — the code-session wire feed `ingestFrame` targets. */
const FEED_CODE_OUTPUT = 0x40;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0507-arc-note-"));
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
        size: { width: 900, height: 640 },
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

describe.skipIf(!SHOULD_RUN)("AT0507: an arc-note row is a quiet line, not an entry", () => {
  test(
    "the derived gesture paints one sentence; a real exchange keeps its entry",
    async () => {
      const app = await launchTugApp({ testName: "at0507-arc-note-quiet-row" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          sessionMode: "resume",
          projectDir,
          workspaceKey: projectDir,
        });

        // An ordinary shell exchange first — the control row that must keep
        // its full entry once the quiet row lands beside it.
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "plain-1",
          command: "echo plain",
          output: "plain",
          cwd: projectDir,
          exitCode: 0,
          startedAtMs: 1_700_000_000_000,
        });

        // The derived gesture: the synthetic `arc` head is the tell, the
        // sentence is the output — exactly what `record_arc_note` writes.
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "note-1",
          command: "arc step demo start",
          output: SENTENCE,
          cwd: projectDir,
          exitCode: 0,
          startedAtMs: 1_700_000_001_000,
        });

        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${CARD} [data-slot="session-transcript-quiet-row"]').length === 1`,
          { timeoutMs: 20_000 },
        );

        const shape = await app.evalJS<{
          sentence: string;
          entries: number;
          addresses: number;
          endStates: number;
          plainEntries: number;
        }>(`(function(){
          var quiet = document.querySelector('${CARD} [data-slot="session-transcript-quiet-row"]');
          return {
            sentence: quiet === null ? "" : (quiet.textContent || "").trim(),
            // Entry scaffolding the quiet row must NOT carry: the transcript
            // entry (participant header, icon-gutter grid), the #s{n}
            // sequence badge, and the exit end-state row.
            entries: quiet === null ? -1 : quiet.querySelectorAll('[data-slot="tug-transcript-entry"]').length,
            addresses: quiet === null ? -1 : quiet.querySelectorAll('[data-slot="tug-transcript-entry-sequence"]').length,
            endStates: quiet === null ? -1 : quiet.querySelectorAll('[data-slot="session-z1b"]').length,
            plainEntries: document.querySelectorAll('${CARD} [data-slot="session-transcript-shell-row"]').length,
          };
        })()`);

        note(`at0507 quiet-row shape: ${JSON.stringify(shape)}`);
        expect(shape.sentence).toBe(SENTENCE);
        expect(shape.entries).toBe(0);
        expect(shape.addresses).toBe(0);
        expect(shape.endStates).toBe(0);
        // The plain exchange keeps its full entry beside the quiet line.
        expect(shape.plainEntries).toBe(1);

        // ---- seat 2: a live note lands INSIDE the streaming turn ----
        // Open a turn (no backend answers, so it stays open), then deliver
        // a live arc note the way the verb store would.
        await app.driveSession("A", { op: "send", text: "work the step" });
        await app.driveSession("A", {
          op: "arcNote",
          exchangeId: "live-note-1",
          command: "arc step demo done",
          text: MID_TURN_SENTENCE,
          cwd: projectDir,
        });

        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${CARD} [data-slot="arc-note"]').length === 1`,
          { timeoutMs: 20_000 },
        );

        const seat = await app.evalJS<{
          text: string;
          insideEntry: boolean;
          quietRows: number;
        }>(`(function(){
          var inTurn = document.querySelector('${CARD} [data-slot="arc-note"]');
          return {
            text: inTurn === null ? "" : (inTurn.textContent || "").trim(),
            // The note sits INSIDE the open turn's transcript entry — the
            // conversational seat — not as a row of its own.
            insideEntry:
              inTurn !== null &&
              inTurn.closest('[data-slot="tug-transcript-entry"]') !== null,
            quietRows: document.querySelectorAll('${CARD} [data-slot="session-transcript-quiet-row"]').length,
          };
        })()`);

        note(`at0507 mid-turn seat: ${JSON.stringify(seat)}`);
        expect(seat.text).toBe(MID_TURN_SENTENCE);
        expect(seat.insideEntry).toBe(true);
        // The live note took the in-turn seat, so the between-turns quiet
        // row count is unchanged from seat 1.
        expect(seat.quietRows).toBe(1);

        // ---- seat 3: the relaunch order — a ledger row meets its turn ----
        // Give the open turn real content and commit it through the shipping
        // frame path, capturing a wall-clock from inside its span.
        const frame = (decoded: Record<string, unknown>): Promise<void> =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: SID, ...decoded },
          });
        await frame({
          type: "content_block_start",
          msg_id: `${SID}-m1`,
          block_index: 0,
          kind: "text",
        });
        await frame({
          type: "assistant_text",
          msg_id: `${SID}-m1`,
          block_index: 0,
          text: "working the step",
          is_partial: false,
        });
        const midTurnTs = Date.now();
        await frame({ type: "turn_complete", msg_id: `${SID}-m1`, result: "success" });

        // The live seat survives the commit.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${CARD} [data-slot="arc-note"]').length === 1`,
          { timeoutMs: 20_000 },
        );

        // A DIFFERENT gesture's ledger row, clocked inside the committed
        // turn's span — the relaunch shape. It must absorb into the turn.
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "restored-42",
          command: "arc commit demo",
          output: RESTORED_SENTENCE,
          cwd: projectDir,
          exitCode: 0,
          startedAtMs: midTurnTs,
        });
        // And the SAME note as seat 2's, replayed from the ledger under the
        // identity the live seat already holds — it must dedup, not double.
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "live-note-1",
          command: "arc step demo done",
          output: MID_TURN_SENTENCE,
          cwd: projectDir,
          exitCode: 0,
          startedAtMs: midTurnTs,
        });

        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${CARD} [data-slot="arc-note"]').length === 2`,
          { timeoutMs: 20_000 },
        );

        const rethread = await app.evalJS<{
          insideEntries: number;
          quietRows: number;
          restoredText: boolean;
        }>(`(function(){
          var seats = Array.from(document.querySelectorAll('${CARD} [data-slot="arc-note"]'));
          return {
            insideEntries: seats.filter(function(el){
              return el.closest('[data-slot="tug-transcript-entry"]') !== null;
            }).length,
            quietRows: document.querySelectorAll('${CARD} [data-slot="session-transcript-quiet-row"]').length,
            restoredText: seats.some(function(el){
              return (el.textContent || "").indexOf(${JSON.stringify(RESTORED_SENTENCE)}) !== -1;
            }),
          };
        })()`);

        note(`at0507 relaunch re-thread: ${JSON.stringify(rethread)}`);
        // Both notes sit inside turns; the replayed twin deduped (2, not 3);
        // the between-turns rows are still only seat 1's.
        expect(rethread.insideEntries).toBe(2);
        expect(rethread.restoredText).toBe(true);
        expect(rethread.quietRows).toBe(1);

        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0507] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

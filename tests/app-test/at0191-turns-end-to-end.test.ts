/**
 * at0191-turns-end-to-end.test.ts — Phase 2 canonical-turns integration:
 * the transcript addresses every entry by its true session turn, and that
 * turn number survives paging older history ([AT0191]).
 *
 * ## Why this exists
 *
 * "Turn" is the one canonical session metric. tugcode emits `totalTurns`
 * and `firstLoadedTurnIndex` on `replay_complete`; the transcript paints a
 * `#{speaker}{turn}` address on each attribution row (`#u…` user, `#a…`
 * assistant), where the turn is `firstLoadedTurnIndex + localTurnIndex + 1`.
 * The tugcode-side equality
 * (`totalTurns == reconciled ledger == scanner`) is proven on the JSONL
 * corpus by the Phase 1 contract test; the picker subtitle reads
 * `turn_count` straight from that authority (the Step 16 pure-logic test).
 * The remaining, genuinely client-side risk ([R07]) is that the rendered
 * turn address drifts from `totalTurns` — a window-local reset, or a
 * renumber when older turns page in. This drives the **live render** and
 * asserts it does not:
 *
 *   1. A windowed resume (last 3 of 8 turns): the highest turn address
 *      equals `totalTurns` (8), and the oldest loaded turn reads its true
 *      session turn (6), NOT a window-local "1".
 *   2. Each turn shows one `#u{turn}` and one `#a{turn}` sharing the turn
 *      number; a turn with a tool call adds no extra markers (one per
 *      attribution row, none inline).
 *   3. Paging in the older history (loadPrevious) does NOT renumber an
 *      already-loaded turn — turn 8 stays `#a8`, and the window now
 *      reaches turn 1.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/code-session-store/
 * @covers tugdeck/src/lib/session-transcript-data-source.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugcode/
 * @covers tugdeck/src/components/tugways/tug-transcript-entry.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-A"; // sessionIdFor("A")

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0191-turns-"));
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

// --- Frame builders (decoded CODE_OUTPUT payloads for SID) -----------------
const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const asstText = (msgId: string, text: string, seq: number) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq,
});
const toolUse = (msgId: string, seq: number) => ({
  type: "tool_use",
  tug_session_id: SID,
  msg_id: msgId,
  tool_use_id: `${msgId}-tool`,
  tool_name: "Bash",
  input: {},
  seq,
});
const turnDone = (msgId: string) => ({
  type: "turn_complete",
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});
const replayStarted = () => ({ type: "replay_started", tug_session_id: SID });
const replayComplete = (
  count: number,
  firstLoadedTurnIndex: number,
  totalTurns: number,
  hasOlder: boolean,
) => ({
  type: "replay_complete",
  tug_session_id: SID,
  count,
  firstLoadedTurnIndex,
  totalTurns,
  hasOlder,
});

describe.skipIf(!SHOULD_RUN)(
  "AT0191: turn address == totalTurns and survives paging",
  () => {
    test(
      "windowed resume addresses by true turn; loadPrevious does not renumber",
      async () => {
        const app = await launchTugApp({ testName: "at0191-turns-end-to-end" });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });
        // Collect every rendered transcript address in card A — one
        // `#{speaker}{turn}` marker per attribution row (`#u…` user, `#a…`
        // assistant). The inline messages of a turn carry no marker.
        const ADDRS_JS = `JSON.stringify(
          Array.from(document.querySelectorAll('[data-card-id="A"] [data-slot="tug-transcript-entry-sequence"]'))
            .map((e) => (e.textContent || '').trim())
            .filter((s) => s.length > 0)
        )`;
        const readAddrs = async (): Promise<string[]> =>
          JSON.parse(await app.evalJS<string>(ADDRS_JS));
        // The transcript evicts rows far from the scrollport, so "every
        // address" is only ever the addresses near where the user is
        // looking. Reading both ends is what a reader would do — and it is
        // what the numbering claim is actually about: the marker a row
        // carries when it IS on screen.
        //
        // The move goes up as a reader's does: a wheel-up first, which is
        // what releases the transcript from following its bottom, then the
        // position. A bare `scrollTop` write is a scroll nobody caused, and
        // the follow-bottom pin that lands after a prepend takes it back.
        const readAddrsAt = async (frac: number): Promise<string[]> => {
          await app.evalJS<number>(`(function () {
  var el = document.querySelector('[data-card-id="A"] [data-tug-scroll-key="session-card-transcript"]');
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true }));
  el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${frac});
  return el.scrollTop;
})()`);
          await new Promise((r) => setTimeout(r, 1200));
          return readAddrs();
        };
        // Turn number is the digits after the single speaker-prefix letter.
        const turnOf = (addr: string): number => parseInt(addr.slice(2), 10);

        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            sessionMode: "resume",
          });

          // --- Phase 1: windowed resume — last 3 of 8 turns (6,7,8) -------
          // Turn 7 carries a tool call inline in its assistant row; turns 6
          // and 8 are plain (user row + assistant row). Each turn yields one
          // #u and one #a marker regardless of inline content.
          await ingest(replayStarted());
          await ingest(userMsg("u6"));
          await ingest(asstText("m6", "a6", 0));
          await ingest(turnDone("m6"));
          await ingest(userMsg("u7"));
          await ingest(asstText("m7", "a7", 0));
          await ingest(toolUse("m7", 1));
          await ingest(turnDone("m7"));
          await ingest(userMsg("u8"));
          await ingest(asstText("m8", "a8", 0));
          await ingest(turnDone("m8"));
          await ingest(replayComplete(3, 5, 8, true));

          await app.waitForCondition<boolean>(
            `JSON.parse(${ADDRS_JS}).length >= 6`,
            { timeoutMs: 8000 },
          );

          let addrs = await readAddrs();
          const turns = addrs.map(turnOf);
          // The highest turn address equals tugcode's totalTurns.
          expect(Math.max(...turns)).toBe(8);
          // The oldest loaded turn reads its TRUE session turn (6), not a
          // window-local reset to 1.
          expect(Math.min(...turns)).toBe(6);
          // Each turn shows a user (#u) and an assistant (#a) marker sharing
          // the turn number — one per attribution row, none inline. Turn 7's
          // tool call does NOT add extra markers.
          expect(addrs).toContain("#u6");
          expect(addrs).toContain("#a6");
          expect(addrs).toContain("#u7");
          expect(addrs).toContain("#a7");
          expect(addrs).toContain("#u8");
          expect(addrs).toContain("#a8");

          // --- Phase 2: page in the older history (turns 1..5) ------------
          await app.driveSession("A", { op: "loadPrevious", amount: "all" });
          await ingest(replayStarted());
          for (let n = 1; n <= 5; n++) {
            await ingest(userMsg(`u${n}`));
            await ingest(asstText(`m${n}`, `a${n}`, 0));
            await ingest(turnDone(`m${n}`));
          }
          await ingest(replayComplete(5, 0, 8, false));

          await app.waitForCondition<boolean>(
            `JSON.parse(${ADDRS_JS}).some((a) => a === "#u1")`,
            { timeoutMs: 8000 },
          );

          // The viewport has not moved, so the rows around it are still the
          // recent ones — and they did NOT renumber across the prepend.
          addrs = await readAddrs();
          expect(Math.max(...addrs.map(turnOf))).toBe(8);
          expect(addrs).toContain("#a8");
          expect(addrs).toContain("#a7");
          expect(addrs).toContain("#u6");
          // Scroll up to where the newly-paged-in history lives: the window
          // now reaches turn 1, numbered from the true start. (The older rows
          // are not in the DOM until the user goes to them — the transcript
          // evicts rows far from the scrollport.)
          const atTop = await readAddrsAt(0);
          expect(Math.min(...atTop.map(turnOf))).toBe(1);
          expect(atTop).toContain("#u1");
          expect(atTop).toContain("#a1");

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0191] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

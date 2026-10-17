/**
 * at0494-find-paint.test.ts — every match find counts is a match the reader
 * can see: painted, in the visible band, and not clipped out of sight.
 *
 * ## Why this exists
 *
 * Find's count comes from a projected text index and its paint from a walk
 * over the live DOM. Where the two disagree, the chip says "k of N" over a
 * transcript showing fewer than N rings, or a ring nobody can see. Three
 * row shapes have done that, and each gets one search here:
 *
 * | Search             | What would break without it                          |
 * |--------------------|------------------------------------------------------|
 * | several tool calls | a turn's later Bash headers left unpainted, or the   |
 * |                    | active match somewhere other than where the anchor   |
 * |                    | put it                                               |
 * | landing receipts   | a match the index counts inside a join or commit     |
 * |                    | receipt body that the painter cannot reach           |
 * | header clamp       | the active match past a collapsed command's clamp,   |
 * |                    | ringed in the clipped dark instead of shown          |
 *
 * All three fixtures share one session, each with its own probe word, so a
 * search for one paints nothing of the others. Each search starts from the
 * live edge — the anchor is then the bottom-most row, and the landing is
 * the probe's last match ([B04], user-settled 2026-09-21) — and Escape ends
 * it before the next opens. The receipts are seeded first: a join settles as
 * a boundary at the transcript's edge, and nothing of this fixture should
 * sit behind it.
 *
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 * @covers tugdeck/src/components/tugways/cards/transcript-search-index.ts
 * @covers tugdeck/src/components/tugways/cards/session-command-block-registry.ts
 * @covers tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/lib/transcript-find-engine.ts
 * @covers tugdeck/src/lib/find-session.ts
 * @family at0494-find
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";
import type { SessionDriveAction } from "./_harness/client";
import { sessionCardShape } from "./_harness/shapes";
import {
  SCROLLER,
  awaitGestureReveal,
  ingest,
  markTrace,
  openFindBar,
  readChip,
  readReveal,
  sessionSelectors,
  waitFrames,
} from "./find-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const SID = "c7c0d1ea-0000-4000-8000-000000000498";
const SEL = sessionSelectors("A");
const SCROLL = `${SEL.card} ${SCROLLER}`;

/** Past the landing flash (`FIND_FLASH_MS`, 640 ms). */
const PAST_FLASH_MS = 800;

/** Planted in three Bash command lines and a reply: five occurrences. */
const MULTI_PROBE = "gossamerprobe";
/** Planted in a receipt BODY — text only the receipt block renders. */
const RECEIPT_PROBE = "cinnabarline";
/** On the LAST line of a command long enough to clamp. */
const CLAMP_PROBE = "vermilionclamp";

/** The bytes `format_join_summary` writes for a squash landing (at0419's). */
const JOIN_SUMMARY = [
  "joined 0123456789 · join-lane → main · 5 round(s)",
  'files: [{"path":"src/a.rs","status":"modified","added":16,"removed":1}]',
  "tugarc(join-lane): land the join surface",
  "",
  `The ${RECEIPT_PROBE} rides the body, which the receipt renders and the`,
  "raw terminal never shows.",
].join("\n");

/** And the `/commit` receipt's own shape, with the probe in its body too. */
const COMMIT_SUMMARY = [
  "committed 89abcdef01 · 1 file(s) · +3 −0",
  'files: [{"path":"src/c.rs","status":"created","added":3,"removed":0}]',
  "tugways(find-paint): mark what the index counts",
  "",
  `A second ${RECEIPT_PROBE} in a commit receipt body.`,
].join("\n");

/** Every painted range, in document order, with the highlight it belongs to. */
const PAINT_CENSUS_EXPR = `(function () {
  var out = [];
  var kinds = [["transcript-find-match", "match"], ["transcript-find-active", "active"]];
  for (var pair of kinds) {
    var hl = CSS.highlights.get(pair[0]);
    if (!hl) continue;
    for (var r of hl) {
      var el = r.startContainer.parentElement;
      var cell = el ? el.closest("[data-tug-list-cell-index]") : null;
      var rect = r.getBoundingClientRect();
      out.push({
        kind: pair[1],
        row: cell ? Number(cell.getAttribute("data-tug-list-cell-index")) : -1,
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        text: r.toString(),
      });
    }
  }
  out.sort(function (a, b) { return a.top - b.top || a.left - b.left; });
  return out;
})()`;

interface Painted {
  kind: string;
  row: number;
  top: number;
  left: number;
  text: string;
}

/**
 * Where the active range is, against the clamp element that holds it — and
 * what is actually under the range's centre, which is the only honest
 * reading of "can the reader see it": a clipped range still has a rect.
 */
const CLAMP_STATE_EXPR = `(function () {
  var hl = CSS.highlights.get('transcript-find-active');
  var range = null;
  if (hl) { for (var r of hl) { range = r; break; } }
  if (range === null) return null;
  var parent = range.startContainer.parentElement;
  var clamp = parent ? parent.closest('.tool-call-header-clamp') : null;
  if (clamp === null) return null;
  var rect = range.getBoundingClientRect();
  var box = clamp.getBoundingClientRect();
  var hit = document.elementFromPoint(
    rect.left + rect.width / 2, rect.top + rect.height / 2);
  return {
    text: range.toString(),
    rectTop: rect.top, rectBottom: rect.bottom,
    clampTop: box.top, clampBottom: box.bottom,
    hitInsideClamp: hit !== null && clamp.contains(hit),
    unclamped: clamp.hasAttribute('data-tugx-find-unclamp'),
  };
})()`;

interface ClampState {
  text: string;
  rectTop: number;
  rectBottom: number;
  clampTop: number;
  clampBottom: number;
  hitInsideClamp: boolean;
  unclamped: boolean;
}

/** One turn, three Bash calls and a closing reply. */
function multiToolTurn(): SessionDriveAction[] {
  const msgId = `${SID}-m0`;
  const steps: SessionDriveAction[] = [
    { op: "send", text: "hunt it down" },
    ingest(SID, { type: "prompt_anchor", promptUuid: `${SID}-u0` }),
  ];
  for (const [i, command] of [
    `which ${MULTI_PROBE}; ${MULTI_PROBE} --help 2>&1 | head -30`,
    `grep -rl "${MULTI_PROBE}" /tmp/at0494 2>/dev/null`,
    `grep "${MULTI_PROBE}" /tmp/at0494/log 2>&1 | head -20`,
  ].entries()) {
    const tuId = `${SID}-tu${i}`;
    steps.push(
      ingest(SID, {
        type: "tool_use",
        seq: 0,
        msg_id: msgId,
        tool_use_id: tuId,
        tool_name: "Bash",
        input: { command, description: `step ${i}` },
      }),
      ingest(SID, {
        type: "tool_result",
        tool_use_id: tuId,
        output: `step ${i} done`,
        is_error: false,
      }),
    );
  }
  steps.push(
    ingest(SID, {
      type: "assistant_text",
      seq: 0,
      rev: 0,
      status: "complete",
      msg_id: msgId,
      block_index: 0,
      text: `This session is named ${MULTI_PROBE}, per the log.`,
      is_partial: false,
    }),
    ingest(SID, { type: "turn_complete", seq: 0, msg_id: msgId, result: "success" }),
  );
  return steps;
}

/** A command long enough that the collapsed header clamps it. */
function clampTurn(): SessionDriveAction[] {
  const lines: string[] = [];
  for (let i = 0; i < 9; i++) lines.push(`echo "filler line number ${i}" \\`);
  lines.push(`  && grep -rn "${CLAMP_PROBE}" /tmp/at0494`);
  return [
    { op: "send", text: "run it" },
    ingest(SID, { type: "prompt_anchor", promptUuid: `${SID}-u1` }),
    ingest(SID, {
      type: "tool_use",
      seq: 0,
      msg_id: "m-clamp",
      tool_use_id: "tc-clamp",
      tool_name: "Bash",
      input: { command: lines.join("\n"), description: "search" },
    }),
    ingest(SID, {
      type: "tool_result",
      tool_use_id: "tc-clamp",
      output: "nothing found",
      is_error: false,
    }),
    ingest(SID, { type: "turn_complete", seq: 0, msg_id: "m-clamp", result: "success" }),
  ];
}

/**
 * Park at the live edge, open find, type `probe`, and wait for the reveal
 * that answers it. Returns that reveal's terminal event.
 */
async function searchFromLiveEdge(
  app: App,
  probe: string,
): Promise<Record<string, unknown> | null> {
  await app.body("A").evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLL}');
  el.scrollTop = el.scrollHeight;
  return el.scrollTop;
})()`);
  await waitFrames(app.body("A"));
  await openFindBar(app);
  const mark = await markTrace(app.body("A"));
  await app.nativeType(probe);
  return awaitGestureReveal(app.body("A"), mark, probe);
}

/** Escape ends the search; wait until the bar is gone. */
async function endSearch(app: App): Promise<void> {
  await app.nativeKey("Escape");
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(SEL.findInput)}) === null`,
    { timeoutMs: 8000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0494: every counted match paints where it can be seen", () => {
  test(
    "several tool calls, landing receipts and a clamped header each paint and reveal their matches",
    async () => {
      const app = await launchTugApp({ testName: "at0494-find-paint" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 760 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15_000 },
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });

        // The receipts, then the multi-tool turn, then the clamp turn.
        await app.driveSessionBatch(
          "A",
          [
            ["/arc-join", JOIN_SUMMARY],
            ["/commit", COMMIT_SUMMARY],
          ].map(
            ([command, output], i): SessionDriveAction => ({
              op: "shellExchange",
              exchangeId: `${SID}-x${i}`,
              command,
              output,
              cwd: "/tmp",
              exitCode: 0,
              startedAtMs: 1_700_000_000_000 + i,
            }),
          ),
        );
        await app.driveSessionBatch("A", multiToolTurn());
        await app.driveSessionBatch("A", clampTurn());
        // A join settles as two rows: the commit receipt in the `Git Commit`
        // entry and the boundary at the transcript's edge ([B01], [B02]). The
        // probe rides the commit's message body, which is in the receipt and
        // mounted without a gesture — what folds behind the boundary is the
        // arc's record, and this fixture carries none. (That the folded record
        // is not projected is pinned in `session-boundary-projection.test.ts`,
        // at the layer that can state it as a function over data.)
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${SEL.card} [data-boundary="join"]') !== null &&
           document.querySelector('${SEL.card} [data-slot="commit-receipt-block"]') !== null &&
           document.querySelector('${SEL.card} [data-slot="join-receipt-block"]') !== null &&
           document.querySelectorAll('${SEL.card} [data-slot="bash-tool-block"]').length === 4`,
          { timeoutMs: 10_000 },
        );

        // ── One turn, several tool calls ──────────────────────────────────
        const multiTerminal = await searchFromLiveEdge(app, MULTI_PROBE);
        note(`multi-tool reveal terminal: ${JSON.stringify(multiTerminal)}`);
        await new Promise((r) => setTimeout(r, PAST_FLASH_MS));
        const multiChip = await readChip(app);
        const multi = await app.body("A").evalJS<Painted[]>(PAINT_CENSUS_EXPR);
        note(`multi-tool chip: ${JSON.stringify(multiChip)}`);
        note(`multi-tool paint census: ${JSON.stringify(multi)}`);
        // Five occurrences: the probe appears twice in the first command and
        // once in each of the others, plus once in the reply. Every one of
        // them must carry paint.
        expect(multi.length, "every mounted match is painted").toBe(5);
        expect(
          multi.filter((c) => c.kind === "active").length,
          "exactly one is the active one",
        ).toBe(1);
        // The last one, not the first: the anchor is the bottom-most visible
        // row and the landing is the last match at or above it ([B04]).
        expect(
          multi[multi.length - 1]?.kind,
          "and it is the last match, where the anchor put it",
        ).toBe("active");
        await endSearch(app);

        // ── Counted means paintable: landing receipts ─────────────────────
        const receiptTerminal = await searchFromLiveEdge(app, RECEIPT_PROBE);
        note(`receipt reveal terminal: ${JSON.stringify(receiptTerminal)}`);
        const receiptChip = await readChip(app);
        const receipts = await app.body("A").evalJS<Painted[]>(PAINT_CENSUS_EXPR);
        const receiptReveal = await readReveal(app);
        note(`receipt chip: ${JSON.stringify(receiptChip)}`);
        note(`receipt paint census: ${JSON.stringify(receipts)}`);
        note(`receipt reveal: ${JSON.stringify(receiptReveal)}`);
        // Both receipt bodies are mounted, so the chip's count and the
        // painted count are the same number. A match the index counts and
        // the painter cannot reach is the defect this pins: it reads "k of 2"
        // over a transcript that never moves. The ordinal is 2: from the
        // live edge the landing is the last match ([B04]).
        expect(receiptChip).toBe("2 of 2");
        expect(receipts.length, "every counted match is painted").toBe(2);
        expect(
          receipts.filter((c) => c.kind === "active").length,
          "one of them is active",
        ).toBe(1);
        expect(receiptReveal?.inView, "and the active one is on screen").toBe(true);
        await endSearch(app);

        // ── A match past a collapsed header's clamp is shown ──────────────
        const clampTerminal = await searchFromLiveEdge(app, CLAMP_PROBE);
        note(`clamp reveal terminal: ${JSON.stringify(clampTerminal)}`);
        await app.body("A").waitForCondition<boolean>(
          `(function(){ var s = ${CLAMP_STATE_EXPR}; return s !== null && s.unclamped; })()`,
          { timeoutMs: 10_000 },
        );
        // Past the landing flash.
        await new Promise((r) => setTimeout(r, PAST_FLASH_MS));
        const state = await app.body("A").evalJS<ClampState | null>(CLAMP_STATE_EXPR);
        note(`clamped-header active match: ${JSON.stringify(state)}`);
        expect(state, "an active range inside the header clamp").not.toBeNull();
        if (state === null) return;
        expect(state.text.toLowerCase()).toBe(CLAMP_PROBE);
        expect(state.rectTop, "the match is inside its header, not below it")
          .toBeGreaterThanOrEqual(state.clampTop - 0.5);
        expect(state.rectBottom).toBeLessThanOrEqual(state.clampBottom + 0.5);
        expect(
          state.hitInsideClamp,
          "what is under the match's centre is the command text itself",
        ).toBe(true);
        const clampReveal = await readReveal(app);
        expect(clampReveal?.inView, "and it is in the visible band").toBe(true);

        // Leaving find puts the clamp back.
        await app.nativeKey("Escape");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${SEL.card} .tool-call-header-clamp[data-tugx-find-unclamp]') === null`,
          { timeoutMs: 8000 },
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

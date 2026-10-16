/**
 * at0494-find-reveal-editor.test.ts — a find reveals matches its plain
 * prose reveal was never built for: one inside an embedded editor, and one
 * in a tool header far above the live edge.
 *
 * ## Why this exists
 *
 * The transcript's reveal places a DOM range it can measure. Two kinds of
 * match break that premise. A match inside an embedded file body lives in
 * CM6, has no transcript-level range at all, and lands on the editor's own
 * measure pass, which the list view cannot see; a match in a tool HEADER
 * sits in a row whose height re-measures as the header settles, and was
 * once revealed and then dropped from the paint after the landing flash.
 * Both are driven past the fold, from the live edge, so the reveal has to
 * travel to reach them.
 *
 * | Test                  | What would break without it                       |
 * |-----------------------|---------------------------------------------------|
 * | embedded file body    | a CM6 match the reveal declares landed off screen |
 * | far tool-header match | the active paint lost once a far reveal settles   |
 *
 * "Settles" is the reveal's own terminal event in the find trace; the one
 * timed wait left is the landing flash (`FIND_FLASH_MS`, 640 ms), which the
 * second test must outlast to say the paint survived it.
 *
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 * @covers tugdeck/src/components/tugways/cards/transcript-search-index.ts
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
  readReveal,
  seedProseTurns,
  sessionSelectors,
  waitFrames,
} from "./find-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const SEL = sessionSelectors("A");
const SCROLL = `${SEL.card} ${SCROLLER}`;

/** Past the landing flash (`FIND_FLASH_MS`, 640 ms). */
const PAST_FLASH_MS = 800;

function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n} is prose long enough that the row occupies real`,
    "height and the transcript grows past a viewport.",
    "",
    `- line ${n}`,
  ].join("\n");
}

async function standUp(testName: string, sid: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 760 }), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
  await app.bindSession("A", { tugSessionId: sid });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  return app;
}

async function parkAtLiveEdge(app: App): Promise<void> {
  await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLL}');
  el.scrollTop = el.scrollHeight;
  return el.scrollTop;
})()`);
  await waitFrames(app);
}

// ---------------------------------------------------------------------------
// The embedded-editor half
// ---------------------------------------------------------------------------

/** Only ever inside the Read block's file body, never in the prose. */
const FILE_PROBE = "obsidianseam";
const FILE_SID = "c7c0d1ea-0000-4000-8000-000000000495";
const READ_BLOCK = `${SEL.card} [data-slot="read-tool-block"]`;

/** 200 lines with the probe once, deep enough to be past the fold. */
function fileBody(): string {
  const lines: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    lines.push(i === 150 ? `const ${FILE_PROBE} = ${i};` : `const line${i} = ${i};`);
  }
  return lines.join("\n");
}

describe.skipIf(!SHOULD_RUN)("AT0494: find reveals a match inside an editor", () => {
  test(
    "a match in an embedded file body lands inside the visible band",
    async () => {
      const app = await standUp("at0494-find-reveal-editor", FILE_SID);
      try {
        // The Read call first, so its file body sits at the TOP of the
        // transcript and the filler turns push it out of the viewport.
        await app.driveSessionBatch("A", [
          { op: "send", text: "read it" },
          ingest(FILE_SID, {
            type: "tool_use",
            seq: 0,
            msg_id: "m-read",
            tool_use_id: "tc-read",
            tool_name: "Read",
            input: { file_path: "/tmp/at0494/sample.ts" },
          }),
          ingest(FILE_SID, { type: "tool_result", is_error: false, tool_use_id: "tc-read", output: "ok" }),
          ingest(FILE_SID, {
            type: "tool_use_structured",
            tool_use_id: "tc-read",
            tool_name: "Read",
            structured_result: {
              type: "text",
              file: {
                content: fileBody(),
                filePath: "/tmp/at0494/sample.ts",
                startLine: 1,
                numLines: 200,
                totalLines: 200,
              },
            },
          }),
          ingest(FILE_SID, { type: "turn_complete", seq: 0, msg_id: "m-read", result: "success" }),
        ]);
        await app.waitForCondition<boolean>(
          `document.querySelector('${READ_BLOCK}') !== null`,
          { timeoutMs: 10_000 },
        );
        // The body is only searchable while the block is expanded — a
        // collapsed call projects its header alone.
        const disclosure = `${READ_BLOCK} [data-slot="tool-call-header-disclosure"]`;
        const collapsed = await app.evalJS<boolean>(
          `document.querySelector('${READ_BLOCK} [data-slot="file-body"]') === null`,
        );
        if (collapsed) await app.click(disclosure);
        await app.waitForCondition<boolean>(
          `document.querySelector('${READ_BLOCK} [data-slot="file-body"]') !== null`,
          { timeoutMs: 8000 },
        );

        await seedProseTurns(app, "A", FILE_SID, 10, replyText);
        // Park at the live edge: the file body is now far above.
        await parkAtLiveEdge(app);

        await openFindBar(app);
        const mark = await markTrace(app);
        await app.nativeType(FILE_PROBE);
        // The match lives in CM6, so the transcript-level active highlight
        // stays empty — the editor's own selected match is the evidence.
        const SELECTED = `${READ_BLOCK} .cm-searchMatch-selected`;
        await app.waitForCondition<boolean>(
          `document.querySelector('${SELECTED}') !== null`,
          { timeoutMs: 15_000 },
        );
        const terminal = await awaitGestureReveal(app, mark, FILE_PROBE);
        note(`editor-match reveal terminal: ${JSON.stringify(terminal)}`);

        const view = await app.evalJS<{
          rectTop: number;
          rectBottom: number;
          bandTop: number;
          bandBottom: number;
          inView: boolean;
        } | null>(`(function () {
  var sc = document.querySelector('${SCROLL}');
  var el = document.querySelector('${SELECTED}');
  if (!sc || !el) return null;
  var rect = el.getBoundingClientRect();
  var box = sc.getBoundingClientRect();
  var pin = parseFloat(getComputedStyle(el).getPropertyValue("--tugx-pin-stack-top")) || 0;
  return {
    rectTop: rect.top,
    rectBottom: rect.bottom,
    bandTop: box.top + pin,
    bandBottom: box.bottom,
    inView: rect.top >= box.top + pin && rect.bottom <= box.bottom,
  };
})()`);
        note(`editor-match reveal: ${JSON.stringify(view)}`);
        expect(terminal, "the reveal must report a terminal outcome").not.toBeNull();
        expect(view).not.toBeNull();
        expect(
          view!.inView,
          `editor match off screen: rect ${view!.rectTop}..${view!.rectBottom} vs band ${view!.bandTop}..${view!.bandBottom}`,
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// …and a tool-header match after a reveal that had to travel
// ---------------------------------------------------------------------------

/** Planted in a Bash command line, so the match lands in a tool HEADER. */
const HEADER_PROBE = "gossamerprobe";
const TRAVEL_SID = "c7c0d1ea-0000-4000-8000-000000000497";
const TRAVEL_TURNS = 20;

/** The active highlight's range, and whether its text is still in the DOM. */
const ACTIVE_STATE_EXPR = `(function () {
  var hl = CSS.highlights.get('transcript-find-active');
  var actives = 0, text = "", connected = false;
  if (hl) {
    for (var r of hl) {
      actives += 1;
      if (actives === 1) {
        text = r.toString();
        connected = r.startContainer.isConnected === true;
      }
    }
  }
  return { actives: actives, text: text, connected: connected };
})()`;

interface ActiveState {
  actives: number;
  text: string;
  connected: boolean;
}

/** One turn's steps: a reply, and — every third turn — a Bash block. */
function travelTurn(n: number): SessionDriveAction[] {
  const msgId = `${TRAVEL_SID}-m${n}`;
  const steps: SessionDriveAction[] = [
    { op: "send", text: `prompt ${n}` },
    ingest(TRAVEL_SID, { type: "prompt_anchor", promptUuid: `${TRAVEL_SID}-u${n}` }),
    ingest(TRAVEL_SID, { type: "content_block_start", msg_id: msgId, block_index: 0, kind: "text" }),
    ingest(TRAVEL_SID, {
      type: "assistant_text",
      seq: 0,
      rev: 0,
      status: "complete",
      msg_id: msgId,
      block_index: 0,
      text: replyText(n),
      is_partial: false,
    }),
  ];
  if (n % 3 === 0) {
    const tuId = `${TRAVEL_SID}-tu${n}`;
    steps.push(
      ingest(TRAVEL_SID, {
        type: "tool_use",
        seq: 0,
        msg_id: msgId,
        tool_use_id: tuId,
        tool_name: "Bash",
        input: {
          command:
            n === 3
              ? `grep -rl "${HEADER_PROBE}" /Users/kocienda/Mounts/u/src/tugtool | head -20`
              : `echo step ${n}`,
          description: `step ${n}`,
        },
      }),
      ingest(TRAVEL_SID, {
        type: "tool_result",
        tool_use_id: tuId,
        output: `step ${n} done`,
        is_error: false,
      }),
    );
  }
  steps.push(ingest(TRAVEL_SID, { type: "turn_complete", seq: 0, msg_id: msgId, result: "success" }));
  return steps;
}

describe.skipIf(!SHOULD_RUN)("AT0494: a revealed match stays painted", () => {
  test(
    "the active match keeps its highlight after a far reveal settles",
    async () => {
      const app = await standUp("at0494-find-paint-travel", TRAVEL_SID);
      try {
        // Twenty turns, every third carrying a Bash block. Turn 3's command
        // holds the probe — a match in a tool HEADER, far above the live edge.
        for (let n = 0; n < TRAVEL_TURNS; n += 1) {
          await app.driveSessionBatch("A", travelTurn(n));
        }
        await app.waitForCondition<boolean>(
          `document.querySelector('${SCROLL}[data-evict-active]') !== null`,
          { timeoutMs: 30_000 },
        );
        await parkAtLiveEdge(app);

        await openFindBar(app);
        const mark = await markTrace(app);
        await app.nativeType(HEADER_PROBE);
        await app.waitForCondition<boolean>(
          `(function(){ var hl = CSS.highlights.get('transcript-find-active');
             if (!hl) return false; for (var _ of hl) return true; return false; })()`,
          { timeoutMs: 15_000 },
        );
        const landed = await app.evalJS<ActiveState>(ACTIVE_STATE_EXPR);
        note(`travelled active at landing: ${JSON.stringify(landed)}`);
        const terminal = await awaitGestureReveal(app, mark, HEADER_PROBE);
        note(`travelled reveal terminal: ${JSON.stringify(terminal)}`);

        await new Promise((r) => setTimeout(r, PAST_FLASH_MS));
        const after = await app.evalJS<ActiveState>(ACTIVE_STATE_EXPR);
        const reveal = await readReveal(app);
        note(`travelled active after the flash: ${JSON.stringify(after)}`);
        note(`travelled reveal: ${JSON.stringify(reveal)}`);

        expect(after.actives, "the active match is still painted").toBe(1);
        expect(after.connected, "its range is still in the document").toBe(true);
        expect(after.text.toLowerCase()).toBe(HEADER_PROBE);
        expect(reveal?.inView, "and still on screen").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

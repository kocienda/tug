/**
 * at0494-find-reveal-in-view.test.ts — a find ALWAYS puts its active match
 * on screen.
 *
 * ## Why this exists
 *
 * The transcript's reveal is a multi-stage affair: an estimated jump across
 * evicted rows, a paint once the target row mounts, then band nudges that
 * clear the pinned entry header at the top and the scroller's own bottom
 * edge. Every stage can hand back a rect that is not yet the settled one —
 * a row that mounts a commit later, a height that re-measures after the
 * nudge — and when one does, the reveal declares itself finished with the
 * match still off screen. The chip then reads "1 of N" over a viewport
 * showing none of them, which is the exact shape of the user report.
 *
 * The assertions are therefore about the ONE observable that matters: after
 * a search settles, the active range's rect lies inside the transcript
 * scroller's visible band. It is driven on a transcript tall enough that
 * the first match is far outside the viewport and its row is evicted — the
 * only geometry in which the staged reveal is exercised at all.
 *
 * | Test              | What would break without it                          |
 * |-------------------|------------------------------------------------------|
 * | search-as-you-type| the first match of a fresh query left off screen      |
 * | wrap to the first | ⌘G past the end landing the view nowhere near match 1 |
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 * @covers tugdeck/src/lib/transcript-find-engine.ts
 * @covers tugdeck/src/lib/find-session.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;
const FEED_CODE_OUTPUT = 0x40;
const SID = "c7c0d1ea-0000-4000-8000-000000000494";

const CARD = '[data-card-id="A"]';
const SCROLLER = '[data-tug-scroll-key="session-card-transcript"]';
const EDITOR = `${CARD} [data-slot="tug-prompt-entry"] [data-slot="tug-text-editor"] .cm-content`;
const FIND_BAR = `${CARD} [data-slot="session-card-find-bar"]`;
const FIND_INPUT = `${FIND_BAR} [data-testid="session-card-find-input"] .cm-content`;

/** Planted once per reply, so every turn holds exactly one match. */
const PROBE = "quartzmarker";
const TURNS = 60;

function deckShape(): Record<string, unknown> {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 760 },
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

/** Synthetic chord at the active element (the at0339 precedent). */
async function chord(
  app: App,
  code: string,
  key: string,
  mods: { meta?: boolean; shift?: boolean } = {},
): Promise<void> {
  await app.evalJS<boolean>(
    `(function(){
      var t = document.activeElement || document;
      return t.dispatchEvent(new KeyboardEvent("keydown", {
        code: ${JSON.stringify(code)},
        key: ${JSON.stringify(key)},
        metaKey: ${mods.meta === true},
        shiftKey: ${mods.shift === true},
        ctrlKey: false,
        altKey: false,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    })()`,
  );
}

function replyText(n: number): string {
  return [
    `## step ${n}`,
    "",
    `Reply number ${n} carries the ${PROBE} once, in prose long enough that`,
    "the row occupies real height and the transcript grows past a viewport.",
    "",
    `- line ${n}`,
  ].join("\n");
}

async function seedTurns(app: App, turns: number): Promise<void> {
  const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
    app.driveSession("A", {
      op: "ingestFrame",
      feedId: FEED_CODE_OUTPUT,
      decoded: { tug_session_id: SID, ...decoded },
    });
  for (let n = 0; n < turns; n += 1) {
    const msgId = `${SID}-m${n}`;
    await app.driveSession("A", { op: "send", text: `prompt ${n}` });
    await frame({ type: "prompt_anchor", promptUuid: `${SID}-u${n}` });
    await frame({
      type: "content_block_start",
      msg_id: msgId,
      block_index: 0,
      kind: "text",
    });
    await frame({
      type: "assistant_text",
      msg_id: msgId,
      block_index: 0,
      text: replyText(n),
      is_partial: false,
    });
    await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
  }
}

/** The active match's rect against the scroller's visible band. */
const REVEAL_EXPR = `(function () {
  var sc = document.querySelector(${JSON.stringify(SCROLLER)});
  var hl = CSS.highlights.get('transcript-find-active');
  if (!sc || !hl) return null;
  var range = null;
  for (var r of hl) { range = r; break; }
  if (range === null) return null;
  var rect = range.getBoundingClientRect();
  var box = sc.getBoundingClientRect();
  var el = range.startContainer.parentElement;
  var pin = el ? (parseFloat(getComputedStyle(el).getPropertyValue("--tugx-pin-stack-top")) || 0) : 0;
  var cell = el ? el.closest("[data-tug-list-cell-index]") : null;
  return {
    row: cell ? Number(cell.getAttribute("data-tug-list-cell-index")) : -1,
    text: range.toString(),
    rectTop: rect.top,
    rectBottom: rect.bottom,
    bandTop: box.top + pin,
    bandBottom: box.bottom,
    inView: rect.top >= box.top + pin && rect.bottom <= box.bottom,
  };
})()`;

interface Reveal {
  row: number;
  text: string;
  rectTop: number;
  rectBottom: number;
  bandTop: number;
  bandBottom: number;
  inView: boolean;
}

async function readReveal(app: App): Promise<Reveal | null> {
  return app.evalJS<Reveal | null>(REVEAL_EXPR);
}

async function standUp(testName: string): Promise<App> {
  const app = await launchTugApp({ testName });
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
    { timeoutMs: 15_000 },
  );
  await app.bindSession("A", { tugSessionId: SID });
  await app.awaitEngineReady("A", { timeoutMs: 20_000 });
  await seedTurns(app, TURNS);
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('${CARD} [data-tug-list-cell-index]').length > 4`,
    { timeoutMs: 30_000 },
  );
  return app;
}

describe.skipIf(!SHOULD_RUN)("AT0494: find reveals its active match", () => {
  test(
    "the first match of a fresh query lands inside the visible band",
    async () => {
      const app = await standUp("at0494-find-reveal");
      try {
        // Park at the live edge — the first match is then the far end of a
        // long jump across evicted rows.
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollHeight;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 600));

        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_INPUT)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.nativeType(PROBE);
        await app.waitForCondition<boolean>(
          `(function(){ var hl = CSS.highlights.get('transcript-find-active');
             if (!hl) return false; for (var _ of hl) return true; return false; })()`,
          { timeoutMs: 10_000 },
        );
        // Let every stage of the staged reveal settle.
        await new Promise((r) => setTimeout(r, 1500));

        const reveal = await readReveal(app);
        const shape = await app.evalJS<Record<string, unknown>>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  return {
    cells: document.querySelectorAll('${CARD} [data-tug-list-cell-index]').length,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    scrollTop: el.scrollTop,
    evicting: el.hasAttribute("data-evict-active"),
  };
})()`);
        note(`transcript shape: ${JSON.stringify(shape)}`);
        note(`first-match reveal: ${JSON.stringify(reveal)}`);
        expect(reveal).not.toBeNull();
        expect(reveal!.text.toLowerCase()).toBe(PROBE);
        expect(reveal!.row, "the first match is the topmost one").toBeLessThan(4);
        expect(
          reveal!.inView,
          `active match off screen: rect ${reveal!.rectTop}..${reveal!.rectBottom} vs band ${reveal!.bandTop}..${reveal!.bandBottom}`,
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The embedded-editor half
// ---------------------------------------------------------------------------

/** Only ever inside the Read block's file body, never in the prose. */
const FILE_PROBE = "obsidianseam";
const FILE_SID = "c7c0d1ea-0000-4000-8000-000000000495";
const READ_BLOCK = `${CARD} [data-slot="read-tool-block"]`;

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
      const app = await launchTugApp({ testName: "at0494-find-reveal-editor" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15_000 },
        );
        await app.bindSession("A", { tugSessionId: FILE_SID });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });

        const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: FILE_SID, ...decoded },
          });

        // The Read call first, so its file body sits at the TOP of the
        // transcript and the filler turns push it out of the viewport.
        await app.driveSession("A", { op: "send", text: "read it" });
        await frame({
          type: "tool_use",
          msg_id: "m-read",
          tool_use_id: "tc-read",
          tool_name: "Read",
          input: { file_path: "/tmp/at0494/sample.ts" },
        });
        await frame({ type: "tool_result", tool_use_id: "tc-read", output: "ok" });
        await frame({
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
        });
        await frame({ type: "turn_complete", msg_id: "m-read", result: "success" });
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

        await seedTurns(app, 30);
        await new Promise((r) => setTimeout(r, 800));
        // Park at the live edge: the file body is now far above.
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollHeight;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 600));

        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_INPUT)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.nativeType(FILE_PROBE);
        // The match lives in CM6, so the transcript-level active highlight
        // stays empty — the editor's own selected match is the evidence.
        const SELECTED = `${READ_BLOCK} .cm-searchMatch-selected`;
        await app.waitForCondition<boolean>(
          `document.querySelector('${SELECTED}') !== null`,
          { timeoutMs: 15_000 },
        );
        await new Promise((r) => setTimeout(r, 1500));

        const view = await app.evalJS<{
          rectTop: number;
          rectBottom: number;
          bandTop: number;
          bandBottom: number;
          inView: boolean;
        } | null>(`(function () {
  var sc = document.querySelector('${SCROLLER}');
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
// The gesture half
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("AT0494: every find gesture shows its match", () => {
  test(
    "extending a query that keeps the same match still brings it back on screen",
    async () => {
      const app = await standUp("at0494-find-reveal-gesture");
      try {
        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_INPUT)}) !== null`,
          { timeoutMs: 8000 },
        );
        // A prefix of the probe: its first match is the same (row, offset)
        // the full probe's first match will be, so the engine PRESERVES the
        // active match when the query is extended. Revealing on a changed
        // identity alone therefore does nothing for the second gesture.
        await app.nativeType(PROBE.slice(0, PROBE.length - 1));
        await app.waitForCondition<boolean>(
          `(function(){ var hl = CSS.highlights.get('transcript-find-active');
             if (!hl) return false; for (var _ of hl) return true; return false; })()`,
          { timeoutMs: 10_000 },
        );
        await new Promise((r) => setTimeout(r, 1200));
        const first = await readReveal(app);
        expect(first?.inView, "the first gesture reveals").toBe(true);

        // The user reads elsewhere — the live edge, as far from match 1 as
        // this transcript goes.
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollHeight;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 600));
        const away = await readReveal(app);
        note(`after scrolling away: ${JSON.stringify(away)}`);

        // …and types the last character. Same match, new gesture.
        await app.nativeType(PROBE.slice(PROBE.length - 1));
        await app.waitForCondition<boolean>(
          `(function(){ var hl = CSS.highlights.get('transcript-find-active');
             if (!hl) return false; for (var _ of hl) return true; return false; })()`,
          { timeoutMs: 10_000 },
        );
        await new Promise((r) => setTimeout(r, 1500));

        const reveal = await readReveal(app);
        note(`after extending the query: ${JSON.stringify(reveal)}`);
        expect(reveal).not.toBeNull();
        expect(reveal!.text.toLowerCase()).toBe(PROBE);
        expect(
          reveal!.inView,
          `active match off screen: rect ${reveal!.rectTop}..${reveal!.rectBottom} vs band ${reveal!.bandTop}..${reveal!.bandBottom}`,
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The persistence half
// ---------------------------------------------------------------------------

/** Planted in the Bash command line, so the match lands in a tool HEADER. */
const HEADER_PROBE = "gossamerprobe";
const HEADER_SID = "c7c0d1ea-0000-4000-8000-000000000496";

/** The active highlight's range, and whether its text is still in the DOM. */
const ACTIVE_STATE_EXPR = `(function () {
  var hl = CSS.highlights.get('transcript-find-active');
  var match = CSS.highlights.get('transcript-find-match');
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
  var matches = 0;
  if (match) { for (var _ of match) matches += 1; }
  return { actives: actives, matches: matches, text: text, connected: connected };
})()`;

interface ActiveState {
  actives: number;
  matches: number;
  text: string;
  connected: boolean;
}

describe.skipIf(!SHOULD_RUN)("AT0494: the active match stays painted", () => {
  test(
    "a match in a tool header keeps its highlight after the landing flash",
    async () => {
      const app = await launchTugApp({ testName: "at0494-find-paint-persists" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15_000 },
        );
        await app.bindSession("A", { tugSessionId: HEADER_SID });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });

        const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: HEADER_SID, ...decoded },
          });

        await app.driveSession("A", { op: "send", text: "run it" });
        await frame({
          type: "tool_use",
          msg_id: "m-bash",
          tool_use_id: "tc-bash",
          tool_name: "Bash",
          input: {
            command: `grep -rl "${HEADER_PROBE}" /tmp/at0494`,
            description: "search",
          },
        });
        await frame({
          type: "tool_result",
          tool_use_id: "tc-bash",
          output: "nothing found",
          is_error: false,
        });
        await frame({
          type: "assistant_text",
          msg_id: "m-bash",
          block_index: 0,
          text: `The ${HEADER_PROBE} appears in the reply too.`,
          is_partial: false,
        });
        await frame({ type: "turn_complete", msg_id: "m-bash", result: "success" });
        await app.waitForCondition<boolean>(
          `document.querySelector('${CARD} [data-slot="bash-tool-block"]') !== null`,
          { timeoutMs: 10_000 },
        );

        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_INPUT)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.nativeType(HEADER_PROBE);
        await app.waitForCondition<boolean>(
          `(function(){ var hl = CSS.highlights.get('transcript-find-active');
             if (!hl) return false; for (var _ of hl) return true; return false; })()`,
          { timeoutMs: 10_000 },
        );
        const landed = await app.evalJS<ActiveState>(ACTIVE_STATE_EXPR);
        note(`active at landing: ${JSON.stringify(landed)}`);

        // Past the landing flash (640ms) and well past any settle.
        await new Promise((r) => setTimeout(r, 2500));
        const after = await app.evalJS<ActiveState>(ACTIVE_STATE_EXPR);
        note(`active after the flash: ${JSON.stringify(after)}`);

        expect(after.actives, "the active match is still painted").toBe(1);
        expect(after.connected, "its range is still in the document").toBe(true);
        expect(after.text.toLowerCase()).toBe(HEADER_PROBE);
        expect(after.matches, "the other matches stay painted too").toBe(
          landed.matches,
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// …and after a reveal that had to travel
// ---------------------------------------------------------------------------

const TRAVEL_SID = "c7c0d1ea-0000-4000-8000-000000000497";

describe.skipIf(!SHOULD_RUN)("AT0494: a revealed match stays painted", () => {
  test(
    "the active match keeps its highlight after a far reveal settles",
    async () => {
      const app = await launchTugApp({ testName: "at0494-find-paint-travel" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15_000 },
        );
        await app.bindSession("A", { tugSessionId: TRAVEL_SID });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });

        const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: TRAVEL_SID, ...decoded },
          });

        // 40 turns, every third carrying a Bash block. Turn 4's command holds
        // the probe — a match in a tool HEADER, far above the live edge.
        for (let n = 0; n < 40; n += 1) {
          const msgId = `${TRAVEL_SID}-m${n}`;
          await app.driveSession("A", { op: "send", text: `prompt ${n}` });
          await frame({ type: "prompt_anchor", promptUuid: `${TRAVEL_SID}-u${n}` });
          await frame({
            type: "content_block_start",
            msg_id: msgId,
            block_index: 0,
            kind: "text",
          });
          await frame({
            type: "assistant_text",
            msg_id: msgId,
            block_index: 0,
            text: replyText(n),
            is_partial: false,
          });
          if (n % 3 === 0) {
            const tuId = `${TRAVEL_SID}-tu${n}`;
            await frame({
              type: "tool_use",
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
            });
            await frame({
              type: "tool_result",
              tool_use_id: tuId,
              output: `step ${n} done`,
              is_error: false,
            });
          }
          await frame({ type: "turn_complete", msg_id: msgId, result: "success" });
        }
        await app.waitForCondition<boolean>(
          `document.querySelector('${SCROLLER}[data-evict-active]') !== null`,
          { timeoutMs: 30_000 },
        );
        await app.evalJS<number>(`(function () {
  var el = document.querySelector('${SCROLLER}');
  el.scrollTop = el.scrollHeight;
  return el.scrollTop;
})()`);
        await new Promise((r) => setTimeout(r, 600));

        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_INPUT)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.nativeType(HEADER_PROBE);
        await app.waitForCondition<boolean>(
          `(function(){ var hl = CSS.highlights.get('transcript-find-active');
             if (!hl) return false; for (var _ of hl) return true; return false; })()`,
          { timeoutMs: 15_000 },
        );
        const landed = await app.evalJS<ActiveState>(ACTIVE_STATE_EXPR);
        note(`travelled active at landing: ${JSON.stringify(landed)}`);

        await new Promise((r) => setTimeout(r, 2500));
        const after = await app.evalJS<ActiveState>(ACTIVE_STATE_EXPR);
        const reveal = await readReveal(app);
        note(`travelled active after the flash: ${JSON.stringify(after)}`);
        note(`travelled reveal: ${JSON.stringify(reveal)}`);

        expect(after.actives, "the active match is still painted").toBe(1);
        expect(after.connected, "its range is still in the document").toBe(true);
        expect(reveal?.inView, "and still on screen").toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// One turn, several tool calls — the shape a real working turn has
// ---------------------------------------------------------------------------

const MULTI_SID = "c7c0d1ea-0000-4000-8000-000000000498";

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

describe.skipIf(!SHOULD_RUN)("AT0494: every mounted match paints", () => {
  test(
    "a turn with several tool calls paints all its matches, and the active one is the first",
    async () => {
      const app = await launchTugApp({ testName: "at0494-find-paint-census" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 15_000 },
        );
        await app.bindSession("A", { tugSessionId: MULTI_SID });
        await app.awaitEngineReady("A", { timeoutMs: 20_000 });

        const frame = (decoded: Record<string, unknown>): Promise<unknown> =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: FEED_CODE_OUTPUT,
            decoded: { tug_session_id: MULTI_SID, ...decoded },
          });

        // One turn, three Bash calls and a closing reply — four occurrences
        // of the probe, all mounted, all on screen.
        await app.driveSession("A", { op: "send", text: "hunt it down" });
        await frame({ type: "prompt_anchor", promptUuid: `${MULTI_SID}-u0` });
        for (const [i, command] of [
          `which ${HEADER_PROBE}; ${HEADER_PROBE} --help 2>&1 | head -30`,
          `grep -rl "${HEADER_PROBE}" /tmp/at0494 2>/dev/null`,
          `grep "${HEADER_PROBE}" /tmp/at0494/log 2>&1 | head -20`,
        ].entries()) {
          const tuId = `${MULTI_SID}-tu${i}`;
          await frame({
            type: "tool_use",
            msg_id: `${MULTI_SID}-m0`,
            tool_use_id: tuId,
            tool_name: "Bash",
            input: { command, description: `step ${i}` },
          });
          await frame({
            type: "tool_result",
            tool_use_id: tuId,
            output: `step ${i} done`,
            is_error: false,
          });
        }
        await frame({
          type: "assistant_text",
          msg_id: `${MULTI_SID}-m0`,
          block_index: 0,
          text: `This session is named ${HEADER_PROBE}, per the log.`,
          is_partial: false,
        });
        await frame({ type: "turn_complete", msg_id: `${MULTI_SID}-m0`, result: "success" });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('${CARD} [data-slot="bash-tool-block"]').length === 3`,
          { timeoutMs: 10_000 },
        );

        await app.nativeClickAtElement(EDITOR);
        await chord(app, "KeyF", "f", { meta: true });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIND_INPUT)}) !== null`,
          { timeoutMs: 8000 },
        );
        await app.nativeType(HEADER_PROBE);
        await app.waitForCondition<boolean>(
          `(function(){ var hl = CSS.highlights.get('transcript-find-active');
             if (!hl) return false; for (var _ of hl) return true; return false; })()`,
          { timeoutMs: 10_000 },
        );
        await new Promise((r) => setTimeout(r, 2500));

        const chip = await app.evalJS<string>(
          `(document.querySelector('${CARD} [data-slot="find-count"] [data-slot="find-count-value"]')?.textContent || "")`,
        );
        const census = await app.evalJS<
          Array<{ kind: string; row: number; top: number; left: number; text: string }>
        >(PAINT_CENSUS_EXPR);
        note(`multi-tool chip: ${JSON.stringify(chip)}`);
        note(`multi-tool paint census: ${JSON.stringify(census)}`);

        // Five occurrences are on screen: the probe appears twice in the
        // first command and once in each of the others, plus once in the
        // reply. Every one of them must carry paint.
        expect(census.length, "every mounted match is painted").toBe(5);
        expect(
          census.filter((c) => c.kind === "active").length,
          "exactly one is the active one",
        ).toBe(1);
        expect(census[0]?.kind, "and it is the topmost match").toBe("active");
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

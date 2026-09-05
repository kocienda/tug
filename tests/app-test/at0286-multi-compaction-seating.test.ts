/**
 * at0286-multi-compaction-seating.test.ts — a replayed session with SEVERAL
 * compactions seats every boundary as a standalone divider, never as an
 * assistant turn ([AT0286]).
 *
 * ## Why this exists
 *
 * at0106 and at0193 both pass with a single compaction, and both predate the
 * frame order current Claude Code produces. Two things changed underneath
 * them. tugcode hoists the `/compact` command envelope to sit immediately
 * BEFORE the `compact_boundary`, so on replay the boundary no longer arrives
 * with "no open turn" — the hoisted `add_user_message` opened one. And
 * Claude's canned reply to a `/compact` is now `No response requested.`, not
 * `Compacted`, so the renderer's compaction-only test stopped matching and the
 * boundary fell through into the assistant attribution: an `Opus …` / `#a`
 * row whose body was the `Session compacted` block plus that literal text.
 *
 * A real 29 MB session with 9 compactions showed both symptoms at once. This
 * drives the same frame sequence — replay bracket, `/compact` envelope,
 * boundary, summary, canned reply, `turn_complete` — twice, through the
 * store's real `frameToEvent → dispatch → render` path, and asserts every
 * boundary reads as a session-meta divider outside any turn attribution.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/session-boundary.tsx
 * @covers tugdeck/src/components/tugways/cards/session-compaction-entry.tsx
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/components/tugways/cards/session-load-control-bar.tsx
 * @covers tugdeck/src/components/tugways/cards/session-load-control-bar-state.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const DIVIDER = '[data-boundary="compaction"]';
const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const TUG_SESSION_ID = "test-session-A"; // bindSession default

// Claude Code's canned reply to a `/compact` dispatch — an acknowledgement of
// the compaction, not the model addressing the user.
const CANNED_REPLY = "No response requested.";

const COMPACTIONS = 3;

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0286-multi-compact-"));
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

/** An ordinary replayed turn: prompt, reply, close. */
function turnFrames(n: number): Array<Record<string, unknown>> {
  return [
    {
      type: "add_user_message",
      content: [{ type: "text", text: `prompt ${n}` }],
    },
    {
      type: "assistant_text",
      msg_id: `msg-turn-${n}`,
      text: `reply ${n}`,
      is_partial: false,
      rev: 0,
      seq: 0,
    },
    { type: "turn_complete", msg_id: `msg-turn-${n}`, result: "success" },
  ];
}

/**
 * One compaction, in the order tugcode's replay emits it after the envelope
 * hoist: the `/compact` envelope opens a turn, the boundary and summary land
 * inside it, and Claude's canned acknowledgement closes it.
 */
function compactionFrames(n: number): Array<Record<string, unknown>> {
  return [
    {
      type: "add_user_message",
      content: [
        {
          type: "text",
          text: "<command-name>/compact</command-name>\n<command-message>compact</command-message>",
        },
      ],
    },
    { type: "compact_boundary", trigger: "manual", pre_tokens: 40_000 + n * 1_000 },
    {
      type: "compact_summary",
      summary:
        "This session is being continued from a previous conversation that " +
        `ran out of context.\n\nSummary ${n}: earlier work.`,
    },
    {
      type: "assistant_text",
      msg_id: `msg-compact-${n}`,
      text: CANNED_REPLY,
      is_partial: false,
      rev: 0,
      seq: 0,
    },
    { type: "turn_complete", msg_id: `msg-compact-${n}`, result: "success" },
  ];
}

describe.skipIf(!SHOULD_RUN)(
  "AT0286: every compaction in a multi-compaction replay seats as a divider",
  () => {
    test(
      "boundaries render outside turn attribution and the canned reply is suppressed",
      async () => {
        const app = await launchTugApp({ testName: "at0286-multi-compaction-seating" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          const frames: Array<Record<string, unknown>> = [{ type: "replay_started" }];
          for (let n = 1; n <= COMPACTIONS; n++) {
            frames.push(...turnFrames(n), ...compactionFrames(n));
          }
          frames.push({ type: "replay_complete", count: COMPACTIONS * 2 });

          for (const decoded of frames) {
            await app.driveSession("A", {
              op: "ingestFrame",
              feedId: CODE_OUTPUT_FEED,
              decoded: { ...decoded, tug_session_id: TUG_SESSION_ID },
            });
          }

          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(DIVIDER)}).length === ${COMPACTIONS}`,
            { timeoutMs: 8000 },
          );

          // Every boundary is a session-meta marker, not a turn: no
          // `.tug-transcript-entry` ancestor (no `Opus …` / `#a` header).
          const attributed = await app.evalJS<number>(
            `Array.from(document.querySelectorAll(${JSON.stringify(DIVIDER)}))` +
              `.filter((el) => el.closest(".tug-transcript-entry") !== null).length`,
          );
          expect(attributed).toBe(0);

          // The transcript evicts rows far from the scrollport, so no single
          // moment holds the whole session's text. Read it the way a reader
          // would: scroll through and accumulate.
          let sweptText = "";
          for (let s = 0; s <= 8; s += 1) {
            await app.evalJS<number>(`(function () {
  var el = document.querySelector('[data-card-id="A"] [data-tug-scroll-key="session-card-transcript"]');
  if (el === null) return -1;
  el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * ${s / 8});
  return el.scrollTop;
})()`);
            await new Promise((r) => setTimeout(r, 250));
            sweptText += await app.evalJS<string>(
              `document.body.textContent || ""`,
            );
          }

          // The canned acknowledgement never becomes transcript ink —
          // asserted across the whole sweep, not one viewport of it.
          expect(sweptText.includes(CANNED_REPLY)).toBe(false);

          // The ordinary turns are undisturbed.
          const repliesShown = Array.from(
            { length: COMPACTIONS },
            (_, i) => `reply ${i + 1}`,
          ).filter((t) => sweptText.includes(t)).length;
          expect(repliesShown).toBe(COMPACTIONS);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0286] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

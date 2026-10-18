/**
 * at0474-arc-run-transcript-rotation.test.ts — an arc run's stage rotation
 * draws a divider, and the transcript survives it, so the whole arc is one
 * scroll ([AT0474]).
 *
 * ## Why this exists
 *
 * An arc run rotates a card onto a fresh claude session between stages
 * (devise → review → implement). tugcode announces each rotation with a
 * `session_segment` line of `kind: "rotation"` and follows it with the fresh
 * session's synthetic `session_init`. Two things have to be true for the arc to
 * read as one
 * piece of work rather than as a card that keeps losing its history:
 *
 *   1. the boundary is visible — a stage divider naming the stage, the model,
 *      and the document it opened on;
 *   2. everything above the boundary stays exactly where it was, including
 *      across the `session_init` the rotation brings with it.
 *
 * The pure halves (`stageNoteText`, the reducer's `handleSessionStage`) are
 * unit-tested and the tugcode emit is covered by
 * `tugcode/src/__tests__/session-stage-rotation.test.ts`. This drives the
 * **live render**: open a turn, inject a synthetic rotation `session_segment` and the
 * `session_init` behind it through the store's real `decode → dispatch`
 * path, and assert both facts on the real DOM. It also carries the arc's
 * mid-session prompt (no rotation, a bare wheel `tug_notice`) and a rotation
 * with no arc behind it.
 *
 * One piece of the at0474-arc-run-transcript split ([B07] of the bodies
 * migration brief): `-restore` carries the lineage restore and the restored
 * arc-note ink, `-interjection` the user's message inside the wheel's turn,
 * live and replayed. The shared constants are `arc-run-transcript-fixture.ts`.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @family at0474-arc-run-transcript
 * @covers tugdeck/src/lib/code-session-store/stages.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/lib/code-session-store/types.ts
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/session-boundary.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-note-block.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launchTugApp, note } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_COMPACT } from "./_harness/shapes";
import {
  CODE_OUTPUT_FEED,
  CONTINUE_PROMPT,
  CONTINUE_PROMPT_ARGS,
  DIVIDER,
  NOTICE_ROW,
  PROMPT,
  REVIEW_PROMPT,
  SHOULD_RUN,
  STAGE_PROMPT,
  STAGE_PROMPT_ARGS,
  TEST_TIMEOUT_MS,
  TUG_SESSION_ID,
  USER_ROW,
  WHEEL_ROW,
  mkProjectDir,
  rmProjectDir,
} from "./arc-run-transcript-fixture";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkProjectDir();
});
afterAll(() => {
  rmProjectDir(projectDir);
});

describe.skipIf(!SHOULD_RUN)(
  "AT0474: an arc's stage rotation is a divider in one transcript",
  () => {
    test(
      "a rotation session_segment draws the boundary and the rows above it survive the rotation",
      async () => {
        const app = await launchTugApp({ testName: "at0474-arc-run-transcript" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            // Generous: a cold single-file run pays the tugdeck Vite
            // first-compile cost, which exceeds the 10s default.
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          // The conversation that precedes the arc, carried to a committed
          // turn — the state a real rotation finds, because the runner only
          // rotates a session that has gone idle.
          await app.driveSession("A", { op: "send", text: PROMPT, atoms: [] });
          await app.body("A").waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(USER_ROW)}).length > 0`,
            { timeoutMs: 6000 },
          );
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "assistant_text",
              seq: 0,
              rev: 0,
              status: "complete",
              tug_session_id: TUG_SESSION_ID,
              msg_id: "m1",
              block_index: 0,
              text: "on it",
              is_partial: false,
            },
          });
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "turn_complete",
              seq: 0,
              tug_session_id: TUG_SESSION_ID,
              msg_id: "m1",
              result: "success",
            },
          });

          // The rotation, as tugcode announces it: the stage line first, then
          // the fresh session's synthetic init.
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "session_segment",
              kind: "rotation",
              tug_session_id: TUG_SESSION_ID,
              parentSessionId: "claude-parent",
              newSessionId: "claude-devise",
              stage: "devise",
              model: "opus",
              document: ".tug/arcs/foo/brief.md",
              arc: "foo",
              prompt: STAGE_PROMPT,
              ipc_version: 2,
            },
          });

          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DIVIDER)}) !== null`,
            { timeoutMs: 6000 },
          );

          // The stage's prompt opens the turn the card will watch, and the row
          // says who spoke: the wheel, never "You" — nobody typed it.
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WHEEL_ROW)}) !== null`,
            { timeoutMs: 6000 },
          );
          const wheelRow = await app.body("A").evalJS<string>(
            `(document.querySelector(${JSON.stringify(WHEEL_ROW)})||{}).textContent || ""`,
          );
          // The prompt opens with a command the runner invoked, so the row
          // shows it as the same command chip a typed command gets, not as
          // characters. The argument remainder stays prose, exactly as
          // written.
          const chipLabel = await app.body("A").evalJS<string>(
            `(document.querySelector(${JSON.stringify(
              `${WHEEL_ROW} [data-atom-label]`,
            )})||{ getAttribute: () => "" }).getAttribute("data-atom-label")`,
          );
          expect(chipLabel).toBe("tugplug:arc-devise");
          expect(wheelRow).toContain(STAGE_PROMPT_ARGS);
          expect(wheelRow).toContain("Wheel");
          expect(wheelRow).not.toContain("You");
          const label = await app.body("A").evalJS<string>(
            `(document.querySelector(${JSON.stringify(DIVIDER)})||{}).textContent || ""`,
          );
          expect(label).toContain("devise");
          expect(label).toContain("opus");
          expect(label).toContain(".tug/arcs/foo/brief.md");

          // A stage boundary takes the transcript's edge, the same seat a
          // compaction and a settled join take: all three are the ground
          // moving under the conversation, so none of them belongs to a
          // speaker's column.
          const stageEdge = await app.body("A").evalJS<number | null>(
            `(() => {
               const b = document.querySelector(${JSON.stringify(DIVIDER)});
               const entry = document.querySelector(".session-card-transcript .tug-transcript-entry");
               if (b === null || entry === null) return null;
               return Math.round(
                 b.getBoundingClientRect().left - entry.getBoundingClientRect().left,
               );
             })()`,
          );
          expect(stageEdge).not.toBeNull();
          expect(Math.abs(stageEdge ?? 99)).toBeLessThanOrEqual(1);

          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "session_init",
              tug_session_id: TUG_SESSION_ID,
              session_id: "claude-devise",
              ipc_version: 2,
            },
          });

          // The claim under test: one transcript. The pre-rotation user row is
          // still on screen after the fresh session's init, with the divider
          // below it — not a cleared card starting over.
          const rows = await app.body("A").evalJS<string>(
            `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
              `${USER_ROW}, ${DIVIDER}`,
            )})).map((el) => el.matches(${JSON.stringify(DIVIDER)}) ? "divider" : "user"))`,
          );
          const order = JSON.parse(rows) as string[];
          expect(order).toContain("user");
          expect(order.indexOf("user")).toBeLessThan(order.indexOf("divider"));

          const stillThere = await app.body("A").evalJS<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(
              USER_ROW,
            )})).some((el) => (el.textContent || "").includes(${JSON.stringify(PROMPT)}))`,
          );
          expect(stillThere).toBe(true);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0474] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the arc's mid-session prompt speaks in the wheel's own row, not as a quote",
      async () => {
        // Not every prompt the arc sends rotates a session. Once a stage is
        // seated, the arc keeps prompting the SAME session — the next step
        // range, a `/compact` — and those arrive as a bare `tug_notice`
        // carrying `origin: "wheel"`, with no `session_segment` in front.
        //
        // They are the same voice as the prompt that opened the stage, so
        // they get the same row. Rendered as a quiet-line note instead, the
        // wheel stopped being the thing steering the session and became
        // something the session was quoting: the prompt that opened the stage
        // read as the wheel talking, and every prompt after it read as a
        // citation of somebody who was no longer in the room.
        const app = await launchTugApp({ testName: "at0474-wheel-mid-session" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          // A turn has to be closed for the arc to prompt at all: it sends
          // between turns, never into one.
          await app.driveSession("A", { op: "send", text: PROMPT, atoms: [] });
          await app.body("A").waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(USER_ROW)}).length > 0`,
            { timeoutMs: 6000 },
          );
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "assistant_text",
              seq: 0,
              rev: 0,
              status: "complete",
              tug_session_id: TUG_SESSION_ID,
              msg_id: "m1",
              block_index: 0,
              text: "step 3 done",
              is_partial: false,
            },
          });
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "turn_complete",
              seq: 0,
              tug_session_id: TUG_SESSION_ID,
              msg_id: "m1",
              result: "success",
            },
          });

          // The arc's next prompt, exactly as tugcast announces it.
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "tug_notice",
              tug_session_id: TUG_SESSION_ID,
              origin: "wheel",
              text: CONTINUE_PROMPT,
            },
          });

          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WHEEL_ROW)}) !== null`,
            { timeoutMs: 6000 },
          );
          const wheelRow = await app.body("A").evalJS<string>(
            `(document.querySelector(${JSON.stringify(WHEEL_ROW)})||{}).textContent || ""`,
          );
          expect(wheelRow).toContain("Wheel");
          expect(wheelRow).toContain(CONTINUE_PROMPT_ARGS);
          expect(wheelRow, "nobody typed it").not.toContain("You");

          // The arc invoked a command, so the row shows the chip a typed
          // command earns — the same treatment the stage opener gets.
          const chipLabel = await app.body("A").evalJS<string>(
            `(document.querySelector(${JSON.stringify(
              `${WHEEL_ROW} [data-atom-label]`,
            )})||{ getAttribute: () => "" }).getAttribute("data-atom-label")`,
          );
          expect(chipLabel).toBe("tugplug:arc-implement");

          // The claim: no quote anywhere. The wheel speaks; it is not quoted.
          const quoted = await app.body("A").evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(NOTICE_ROW)}).length`,
          );
          expect(quoted, "the wheel is a participant, not a citation").toBe(0);

          // And the turn above it is untouched — the prompt opened a new turn
          // rather than being folded into the one that just ended.
          const stillThere = await app.body("A").evalJS<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(
              USER_ROW,
            )})).some((el) => (el.textContent || "").includes(${JSON.stringify(PROMPT)}))`,
          );
          expect(stillThere).toBe(true);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0474] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a rotation with no arc behind it draws its divider and leaves the transcript alone",
      async () => {
        // The wheel's primitive is not the arc's. A rotation nobody is
        // scoring carries no `arc` and no `document`, and the boundary must
        // still be visible and still be a boundary — a divider naming the
        // stage and the model, with everything above it exactly where it was.
        const app = await launchTugApp({ testName: "at0474-wheel-rotation" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          await app.driveSession("A", { op: "send", text: PROMPT, atoms: [] });
          await app.body("A").waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(USER_ROW)}).length > 0`,
            { timeoutMs: 6000 },
          );
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "turn_complete",
              seq: 0,
              tug_session_id: TUG_SESSION_ID,
              msg_id: "m1",
              result: "success",
            },
          });

          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "session_segment",
              kind: "rotation",
              tug_session_id: TUG_SESSION_ID,
              parentSessionId: "claude-parent",
              newSessionId: "claude-review",
              stage: "review",
              model: "opus",
              prompt: REVIEW_PROMPT,
              ipc_version: 2,
            },
          });

          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DIVIDER)}) !== null`,
            { timeoutMs: 6000 },
          );
          const label = await app.body("A").evalJS<string>(
            `(document.querySelector(${JSON.stringify(DIVIDER)})||{}).textContent || ""`,
          );
          expect(label).toContain("review");
          expect(label).toContain("opus");
          // No arc opened it on anything, so the boundary names nothing it
          // was not given: the stage is the event, the model is the trailing
          // badge, and there is no detail element at all rather than an empty
          // one where a document would be.
          const bare = await app.body("A").evalJS<{
            event: string;
            details: number;
            badge: string;
          }>(
            `(() => {
               const b = document.querySelector(${JSON.stringify(DIVIDER)});
               return {
                 event: (b.querySelector(".session-boundary-event")?.textContent ?? "").trim(),
                 details: b.querySelectorAll(".session-boundary-detail").length,
                 badge: Array.from(
                   b.querySelectorAll('[data-slot="tool-call-header-summary"]'),
                 ).map((s) => (s.textContent ?? "").trim()).join(" "),
               };
             })()`,
          );
          note(`at0474 documentless stage boundary: ${JSON.stringify(bare)}`);
          expect(bare.event).toBe("Stage · review");
          expect(bare.details, "no detail element where a document would be").toBe(0);
          expect(bare.badge).toBe("opus");
          expect(label).not.toContain(".tug/");

          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "session_init",
              tug_session_id: TUG_SESSION_ID,
              session_id: "claude-review",
              ipc_version: 2,
            },
          });

          const stillThere = await app.body("A").evalJS<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(
              USER_ROW,
            )})).some((el) => (el.textContent || "").includes(${JSON.stringify(PROMPT)}))`,
          );
          expect(stillThere).toBe(true);

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") process.stderr.write(`\n[at0474] log tail:\n${tail}\n`);
          throw err;
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

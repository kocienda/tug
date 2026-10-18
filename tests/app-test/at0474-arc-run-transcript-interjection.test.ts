/**
 * at0474-arc-run-transcript-interjection.test.ts — a message the user types
 * into the wheel's stage turn is still the user's, live and after a relaunch
 * replays the stage ([AT0474]).
 *
 * The wheel opens a stage turn and the user interjects while it runs. Claude
 * merges that message at the next agent-loop boundary, so it lands INSIDE the
 * wheel's turn; a row that reads its turn's attribution instead of its own
 * puts the wheel's name and sigil on words the user typed. The replay leg
 * holds the same on the restore path, where a steered message comes back as
 * an origin-less `add_user_message` threaded into the open bracket.
 *
 * One piece of the at0474-arc-run-transcript split ([B07] of the bodies
 * migration brief): `-rotation` carries the live rotation, `-restore` the
 * lineage restore. The shared constants are `arc-run-transcript-fixture.ts`.
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
import { launchTugApp } from "./_harness";
import { sessionCardShape, SESSION_CARD_SIZE_COMPACT } from "./_harness/shapes";
import {
  CODE_OUTPUT_FEED,
  ENTRY,
  INTERJECTION,
  SHOULD_RUN,
  STAGE_PROMPT,
  STAGE_PROMPT_ARGS,
  TEST_TIMEOUT_MS,
  TUG_SESSION_ID,
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
      "a message the user types into the wheel's turn is still the user's",
      async () => {
        // The wheel opens a stage turn and the user interjects while it runs.
        // Claude merges that message at the next agent-loop boundary, so it
        // lands INSIDE the wheel's turn — and a row that reads its turn's
        // attribution instead of its own puts the wheel's name and the wheel's
        // sigil on words the user typed.
        const app = await launchTugApp({ testName: "at0474-wheel-interjection" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          const ingest = (decoded: Record<string, unknown>) =>
            app.driveSession("A", {
              op: "ingestFrame",
              feedId: CODE_OUTPUT_FEED,
              decoded: { tug_session_id: TUG_SESSION_ID, ipc_version: 2, ...decoded },
            });

          // The stage opens on the wheel's prompt, which is the turn the
          // interjection will land in.
          await ingest({
            type: "session_segment",
            kind: "rotation",
            parentSessionId: "claude-parent",
            newSessionId: "claude-implement",
            stage: "implement",
            model: "opus",
            document: ".tug/arcs/foo/plan.md",
            arc: "foo",
            prompt: STAGE_PROMPT,
          });
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WHEEL_ROW)}) !== null`,
            { timeoutMs: 6000 },
          );

          // The turn reaches a tool call, the user types, and the next
          // tool_result is the boundary at which the message is picked up.
          await ingest({
            type: "tool_use",
            msg_id: "m9",
            tool_use_id: "tc-9",
            tool_name: "Read",
            input: { file_path: "/tmp/x" },
            seq: 1,
          });
          await app.driveSession("A", { op: "send", text: INTERJECTION, atoms: [] });
          await ingest({ type: "tool_result", is_error: false, tool_use_id: "tc-9", output: "ok" });

          await app.body("A").waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(
              ENTRY,
            )})).some((el) => (el.textContent || "").includes(${JSON.stringify(
              INTERJECTION,
            )}))`,
            { timeoutMs: 8000 },
          );

          const rows = JSON.parse(
            await app.body("A").evalJS<string>(
              `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
                ENTRY,
              )})).map((el) => [el.getAttribute("data-participant"), (el.textContent || "").trim()]))`,
            ),
          ) as Array<[string, string]>;

          const typed = rows.filter(([, t]) => t.includes(INTERJECTION));
          expect(typed.length, "the typed message is on screen exactly once").toBe(1);
          expect(
            typed[0]![0],
            "the user's own words carry the user's attribution, not the wheel's",
          ).toBe("user");

          // The wheel's own prompt keeps its name — this is a per-message
          // reading, not a turn-wide one, so the same turn holds both.
          const wheelRows = rows.filter(([p]) => p === "wheel");
          expect(wheelRows.length, "the stage prompt is still the wheel's").toBe(1);
          expect(wheelRows[0]![1]).toContain(STAGE_PROMPT_ARGS);

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
      "and it is still the user's after a relaunch replays the stage",
      async () => {
        // The restore leg of the same claim. A steered message persists in the
        // JSONL only as a `queued_command` attachment, which the translator
        // turns into an origin-less `add_user_message` threaded into the open
        // bracket — while the stage's opening frame is the one the translator
        // marks. The reducer must keep those two apart on the replay path as
        // well as on the live one, or every reopened arc relabels the words
        // the user typed into it.
        const app = await launchTugApp({ testName: "at0474-wheel-interjection-replay" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          const ingest = (decoded: Record<string, unknown>) =>
            app.driveSession("A", {
              op: "ingestFrame",
              feedId: CODE_OUTPUT_FEED,
              decoded: { tug_session_id: TUG_SESSION_ID, ipc_version: 2, ...decoded },
            });

          await ingest({ type: "replay_started" });
          await ingest({
            type: "replay_stage",
            stage: "implement",
            model: "opus",
            document: ".tug/arcs/foo/tasks.md",
            arc: "foo",
          });
          // The stage opener, as the translator states it.
          await ingest({
            type: "add_user_message",
            content: [{ type: "text", text: STAGE_PROMPT }],
            origin: "wheel",
          });
          await ingest({
            type: "tool_use",
            msg_id: "m9",
            tool_use_id: "tc-9",
            tool_name: "Read",
            input: { file_path: "/tmp/x" },
            seq: 1,
          });
          await ingest({ type: "tool_result", is_error: false, tool_use_id: "tc-9", output: "ok" });
          // The interjection, as a `queued_command` attachment restores it:
          // mid-bracket, and stating no origin at all.
          await ingest({
            type: "add_user_message",
            content: [{ type: "text", text: INTERJECTION }],
          });
          await ingest({
            type: "assistant_text",
            seq: 0,
            rev: 0,
            status: "complete",
            msg_id: "m9",
            block_index: 0,
            text: "will do",
            is_partial: false,
          });
          await ingest({ type: "turn_complete", seq: 0, msg_id: "m9", result: "success" });
          await ingest({ type: "replay_complete", count: 1 });

          await app.body("A").waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(
              ENTRY,
            )})).some((el) => (el.textContent || "").includes(${JSON.stringify(
              INTERJECTION,
            )}))`,
            { timeoutMs: 8000 },
          );

          const rows = JSON.parse(
            await app.body("A").evalJS<string>(
              `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
                ENTRY,
              )})).map((el) => [el.getAttribute("data-participant"), (el.textContent || "").trim()]))`,
            ),
          ) as Array<[string, string]>;

          const typed = rows.filter(([, t]) => t.includes(INTERJECTION));
          expect(typed.length, "the restored message is on screen exactly once").toBe(1);
          expect(
            typed[0]![0],
            "a restored interjection is the user's, not the wheel's",
          ).toBe("user");

          const wheelRows = rows.filter(([p]) => p === "wheel");
          expect(wheelRows.length, "the replayed stage prompt is the wheel's").toBe(1);
          expect(wheelRows[0]![1]).toContain(STAGE_PROMPT_ARGS);

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

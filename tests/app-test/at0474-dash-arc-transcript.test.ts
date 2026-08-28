/**
 * at0474-dash-arc-transcript.test.ts — a dash arc's stage rotation draws a
 * divider, and the transcript survives it, so the whole arc is one scroll
 * ([AT0474]).
 *
 * ## Why this exists
 *
 * A dash arc rotates a card onto a fresh claude session between stages
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
 * `session_init` behind it through the store's real `frameToEvent → dispatch`
 * path, and assert both facts on the real DOM.
 *
 * The second test is the restore leg. On relaunch the arc's whole lineage is
 * replayed — one JSONL per stage, a `replay_stage` divider at every boundary
 * — and the card must end up showing the same one scroll it showed live.
 *

 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/code-session-store/stages.ts
 * @covers tugdeck/src/lib/code-session-store/reducer.ts
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/lib/code-session-store/types.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const DIVIDER = '[data-slot="stage-divider"]';
const USER_ROW = '[data-testid="session-card-transcript-user-body"]';
const WHEEL_ROW = '.tug-transcript-entry[data-participant="wheel"]';
const STAGE_PROMPT =
  "/tugplug:dash-devise a plan for .tug/dashes/foo/brief.md";
/** What the transcript paints as prose once the command becomes a chip. */
const STAGE_PROMPT_ARGS = "a plan for .tug/dashes/foo/brief.md";
// Every stage after devise names the dash, never a path.
const REVIEW_PROMPT = "/tugplug:dash-review foo";
/**
 * A prompt the arc sends MID-session — a continued implement range. It does
 * not rotate anything, so it arrives as a bare `tug_notice` rather than
 * behind a `session_segment`.
 */
const CONTINUE_PROMPT =
  "/tugplug:dash-implement foo Steps 4-13 — close one step and end your turn";
const CONTINUE_PROMPT_ARGS = "Steps 4-13 — close one step and end your turn";
/** The quiet-line row a nameless subsystem's notice gets. The wheel has a name. */
const NOTICE_ROW = '[data-slot="tug-notice"]';
const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const TUG_SESSION_ID = "test-session-A"; // bindSession default
const PROMPT = "write the brief";
const INTERJECTION = "keep the spike. skip step 7 when you get to it.";
/** Every attributed transcript row, whoever spoke it. */
const ENTRY = ".tug-transcript-entry[data-participant]";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0474-arc-"));
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

describe.skipIf(!SHOULD_RUN)(
  "AT0474: an arc's stage rotation is a divider in one transcript",
  () => {
    test(
      "a rotation session_segment draws the boundary and the rows above it survive the rotation",
      async () => {
        const app = await launchTugApp({ testName: "at0474-dash-arc-transcript" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
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
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(USER_ROW)}).length > 0`,
            { timeoutMs: 6000 },
          );
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "assistant_text",
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
              document: ".tug/dashes/foo/brief.md",
              arc: "foo",
              prompt: STAGE_PROMPT,
              ipc_version: 2,
            },
          });

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DIVIDER)}) !== null`,
            { timeoutMs: 6000 },
          );

          // The stage's prompt opens the turn the card will watch, and the row
          // says who spoke: the wheel, never "You" — nobody typed it.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WHEEL_ROW)}) !== null`,
            { timeoutMs: 6000 },
          );
          const wheelRow = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(WHEEL_ROW)})||{}).textContent || ""`,
          );
          // The prompt opens with a command the runner invoked, so the row
          // shows it as the same command chip a typed command gets, not as
          // characters. The argument remainder stays prose, exactly as
          // written.
          const chipLabel = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(
              `${WHEEL_ROW} [data-atom-label]`,
            )})||{ getAttribute: () => "" }).getAttribute("data-atom-label")`,
          );
          expect(chipLabel).toBe("tugplug:dash-devise");
          expect(wheelRow).toContain(STAGE_PROMPT_ARGS);
          expect(wheelRow).toContain("Wheel");
          expect(wheelRow).not.toContain("You");
          const label = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(DIVIDER)})||{}).textContent || ""`,
          );
          expect(label).toContain("devise");
          expect(label).toContain("opus");
          expect(label).toContain(".tug/dashes/foo/brief.md");

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
          const rows = await app.evalJS<string>(
            `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
              `${USER_ROW}, ${DIVIDER}`,
            )})).map((el) => el.matches(${JSON.stringify(DIVIDER)}) ? "divider" : "user"))`,
          );
          const order = JSON.parse(rows) as string[];
          expect(order).toContain("user");
          expect(order.indexOf("user")).toBeLessThan(order.indexOf("divider"));

          const stillThere = await app.evalJS<boolean>(
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
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          // A turn has to be closed for the arc to prompt at all: it sends
          // between turns, never into one.
          await app.driveSession("A", { op: "send", text: PROMPT, atoms: [] });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(USER_ROW)}).length > 0`,
            { timeoutMs: 6000 },
          );
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "assistant_text",
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

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(WHEEL_ROW)}) !== null`,
            { timeoutMs: 6000 },
          );
          const wheelRow = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(WHEEL_ROW)})||{}).textContent || ""`,
          );
          expect(wheelRow).toContain("Wheel");
          expect(wheelRow).toContain(CONTINUE_PROMPT_ARGS);
          expect(wheelRow, "nobody typed it").not.toContain("You");

          // The arc invoked a command, so the row shows the chip a typed
          // command earns — the same treatment the stage opener gets.
          const chipLabel = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(
              `${WHEEL_ROW} [data-atom-label]`,
            )})||{ getAttribute: () => "" }).getAttribute("data-atom-label")`,
          );
          expect(chipLabel).toBe("tugplug:dash-implement");

          // The claim: no quote anywhere. The wheel speaks; it is not quoted.
          const quoted = await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(NOTICE_ROW)}).length`,
          );
          expect(quoted, "the wheel is a participant, not a citation").toBe(0);

          // And the turn above it is untouched — the prompt opened a new turn
          // rather than being folded into the one that just ended.
          const stillThere = await app.evalJS<boolean>(
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
      "a rotation with no course behind it draws its divider and leaves the transcript alone",
      async () => {
        // The wheel's primitive is not the arc's. A rotation nobody is
        // scoring carries no `arc` and no `document`, and the boundary must
        // still be visible and still be a boundary — a divider naming the
        // stage and the model, with everything above it exactly where it was.
        const app = await launchTugApp({ testName: "at0474-wheel-rotation" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          await app.driveSession("A", { op: "send", text: PROMPT, atoms: [] });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(USER_ROW)}).length > 0`,
            { timeoutMs: 6000 },
          );
          await app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: {
              type: "turn_complete",
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

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DIVIDER)}) !== null`,
            { timeoutMs: 6000 },
          );
          const label = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(DIVIDER)})||{}).textContent || ""`,
          );
          expect(label).toContain("review");
          expect(label).toContain("opus");
          // No course opened it on anything, so the divider names nothing it
          // was not given: the text ends at the model, with no trailing
          // separator and no blank where a document would be.
          expect(label.trim().endsWith("review · opus")).toBe(true);
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

          const stillThere = await app.evalJS<boolean>(
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
      "a lineage restore renders the arc's stages in order, dividers and all",
      async () => {
        // The restore leg. On relaunch tugcast hands tugcode the arc's whole
        // lineage and tugcode replays each stage's JSONL in turn, emitting a
        // `replay_stage` divider at every boundary — a separate wire type
        // from `session_segment`, because a replayed rotation is only a divider
        // and must not re-stage an identity transfer that already happened.
        // This drives that frame sequence through the store's real dispatch
        // and asserts what the card ends up showing.
        const app = await launchTugApp({ testName: "at0474-dash-arc-restore" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", { projectDir });
          await app.awaitEngineReady("A", { timeoutMs: 30_000 });

          const ingest = async (decoded: Record<string, unknown>): Promise<void> => {
            await app.driveSession("A", {
              op: "ingestFrame",
              feedId: CODE_OUTPUT_FEED,
              decoded: { tug_session_id: TUG_SESSION_ID, ...decoded },
            });
          };
          const replayTurn = async (msgId: string, text: string): Promise<void> => {
            await ingest({
              type: "add_user_message",
              content: [{ type: "text", text }],
            });
            await ingest({
              type: "assistant_text",
              msg_id: msgId,
              block_index: 0,
              text: `re: ${text}`,
              is_partial: false,
            });
            await ingest({ type: "turn_complete", msg_id: msgId, result: "success" });
          };

          await ingest({ type: "replay_started" });
          await replayTurn("r1", PROMPT);
          await ingest({
            type: "replay_stage",
            stage: "devise",
            model: "opus",
            document: ".tug/dashes/foo/brief.md",
            arc: "foo",
          });
          await replayTurn("r2", "write the plan");
          await ingest({ type: "replay_complete", count: 2 });

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DIVIDER)}) !== null`,
            { timeoutMs: 6000 },
          );

          // Conversation → divider → devise, in that order, in one transcript.
          const order = JSON.parse(
            await app.evalJS<string>(
              `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
                `${USER_ROW}, ${DIVIDER}`,
              )})).map((el) => el.matches(${JSON.stringify(
                DIVIDER,
              )}) ? "divider" : (el.textContent || "").trim()))`,
            ),
          ) as string[];
          const dividerAt = order.indexOf("divider");
          expect(dividerAt).toBeGreaterThan(-1);
          expect(order.slice(0, dividerAt).join(" ")).toContain(PROMPT);
          expect(order.slice(dividerAt + 1).join(" ")).toContain("write the plan");

          // Exactly one divider — a boundary replayed twice would double it.
          expect(order.filter((r) => r === "divider").length).toBe(1);

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
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
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
            document: ".tug/dashes/foo/plan.md",
            arc: "foo",
            prompt: STAGE_PROMPT,
          });
          await app.waitForCondition<boolean>(
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
          await ingest({ type: "tool_result", tool_use_id: "tc-9", output: "ok" });

          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(
              ENTRY,
            )})).some((el) => (el.textContent || "").includes(${JSON.stringify(
              INTERJECTION,
            )}))`,
            { timeoutMs: 8000 },
          );

          const rows = JSON.parse(
            await app.evalJS<string>(
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
        // well as on the live one, or every reopened dash relabels the words
        // the user typed into it.
        const app = await launchTugApp({ testName: "at0474-wheel-interjection-replay" });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
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
          await ingest({ type: "replay_stage", stage: "implement", model: "opus", arc: "foo" });
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
          await ingest({ type: "tool_result", tool_use_id: "tc-9", output: "ok" });
          // The interjection, as a `queued_command` attachment restores it:
          // mid-bracket, and stating no origin at all.
          await ingest({
            type: "add_user_message",
            content: [{ type: "text", text: INTERJECTION }],
          });
          await ingest({
            type: "assistant_text",
            msg_id: "m9",
            block_index: 0,
            text: "will do",
            is_partial: false,
          });
          await ingest({ type: "turn_complete", msg_id: "m9", result: "success" });
          await ingest({ type: "replay_complete", count: 1 });

          await app.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(
              ENTRY,
            )})).some((el) => (el.textContent || "").includes(${JSON.stringify(
              INTERJECTION,
            )}))`,
            { timeoutMs: 8000 },
          );

          const rows = JSON.parse(
            await app.evalJS<string>(
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

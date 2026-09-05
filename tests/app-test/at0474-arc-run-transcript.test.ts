/**
 * at0474-arc-run-transcript.test.ts — an arc run's stage rotation draws a
 * divider, and the transcript survives it, so the whole arc is one scroll
 * ([AT0474]).
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
 * @covers tugdeck/src/lib/shell-session-store.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-note-block.tsx
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
  "/tugplug:arc-devise a plan for .tug/arcs/foo/brief.md";
/** What the transcript paints as prose once the command becomes a chip. */
const STAGE_PROMPT_ARGS = "a plan for .tug/arcs/foo/brief.md";
// Every stage after devise names the arc, never a path.
const REVIEW_PROMPT = "/tugplug:arc-review foo";
/**
 * A prompt the arc sends MID-session — a continued implement range. It does
 * not rotate anything, so it arrives as a bare `tug_notice` rather than
 * behind a `session_segment`.
 */
const CONTINUE_PROMPT =
  "/tugplug:arc-implement foo implement Step 4 and end your turn; Steps 4-13 remain on this run";
const CONTINUE_PROMPT_ARGS = "implement Step 4 and end your turn; Steps 4-13 remain on this run";
/** The quiet-line row a nameless subsystem's notice gets. The wheel has a name. */
const NOTICE_ROW = '[data-slot="tug-notice"]';
/** An arc gesture's quiet line, absorbed into the turn it narrated ([P12]). */
const ARC_NOTE_IN_TURN = '[data-slot="arc-note"]';
/** The same line stranded between turns — the seat a row with no turn takes. */
const ARC_NOTE_BETWEEN_TURNS = '[data-slot="session-arc-note-line"]';
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
        const app = await launchTugApp({ testName: "at0474-arc-run-transcript" });
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
              document: ".tug/arcs/foo/brief.md",
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
          expect(chipLabel).toBe("tugplug:arc-devise");
          expect(wheelRow).toContain(STAGE_PROMPT_ARGS);
          expect(wheelRow).toContain("Wheel");
          expect(wheelRow).not.toContain("You");
          const label = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(DIVIDER)})||{}).textContent || ""`,
          );
          expect(label).toContain("devise");
          expect(label).toContain("opus");
          expect(label).toContain(".tug/arcs/foo/brief.md");

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
          expect(chipLabel).toBe("tugplug:arc-implement");

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
      "a rotation with no arc behind it draws its divider and leaves the transcript alone",
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
          // No arc opened it on anything, so the divider names nothing it
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
        const app = await launchTugApp({ testName: "at0474-arc-run-restore" });
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
            document: ".tug/arcs/foo/brief.md",
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
      "restored arc-note ink seats inside the turns it narrated across a whole-line replay",
      async () => {
        // The report this pins: an arc line restored through the resume sheet
        // showed every one of its quiet lines stacked at the top of the card,
        // above a transcript that began hours after they were written. The ink
        // was anchored correctly the whole time — the card had simply replayed
        // one segment of a three-segment line, so the turns those anchors name
        // were not loaded, and every row took the clock-order fallback seat
        // that a missing anchor is supposed to get.
        //
        // With the lineage replayed the anchors resolve, and this is the DOM
        // reading of "seated exactly where they appeared": each line inside the
        // turn whose span holds its clock, in message order, and nothing quiet
        // standing above the first turn. The frames are injected the way the
        // restore leg above already injects them; the ledger rows arrive in the
        // `list_shell_exchanges_ok` shape the server answers with.
        const app = await launchTugApp({ testName: "at0474-arc-note-seating" });
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

          // A turn with a span the test states, so a row's clock can be placed
          // inside it or outside it deliberately rather than by luck.
          const replaySpan = async (
            msgId: string,
            text: string,
            openedAt: number,
            endedAt: number,
          ): Promise<void> => {
            await ingest({
              type: "add_user_message",
              content: [{ type: "text", text }],
              timestamp: openedAt,
            });
            await ingest({
              type: "assistant_text",
              msg_id: msgId,
              block_index: 0,
              text: `re: ${text}`,
              is_partial: false,
            });
            await ingest({ type: "turn_complete", msg_id: msgId, result: "success", timestamp: endedAt });
          };

          // Round numbers an hour back, so the clocks read as history rather
          // than as this second and a stray `Date.now()` default cannot pass
          // for one of them.
          const T = Math.floor((Date.now() - 3_600_000) / 1000) * 1000;

          await ingest({ type: "replay_started" });
          // The door: one turn, no stage of its own.
          await replaySpan("m-door", PROMPT, T, T + 1_000);
          await ingest({
            type: "replay_stage",
            stage: "implement",
            model: "opus",
            document: ".tug/arcs/foo/tasks.md",
            arc: "foo",
          });
          await replaySpan("m-impl-1", "implement Step 1", T + 10_000, T + 20_000);
          await replaySpan("m-impl-2", "implement Step 2", T + 30_000, T + 40_000);
          await ingest({
            type: "replay_stage",
            stage: "audit",
            model: "opus",
            arc: "foo",
          });
          await replaySpan("m-audit", "audit the branch", T + 50_000, T + 60_000);
          await ingest({ type: "replay_complete", count: 4 });

          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(USER_ROW)}).length === 4`,
            { timeoutMs: 8000 },
          );

          // The ledger's answer: every row anchored into the implement segment,
          // every clock inside the span of the turn its anchor names. Delivered
          // after the replay, which is the order the restore actually takes —
          // the card asks for its shell ledger once the session is up.
          await app.driveSession("A", {
            op: "restoreShellExchanges",
            rows: [
              {
                id: 2125,
                command: "arc step foo start",
                output: "foo: step 1/2 started — Seed the lineage from the id the spawn resumes",
                exit_code: 0,
                cwd: projectDir,
                started_at_ms: T + 12_000,
                settled_at_ms: T + 12_000,
                anchor_msg_id: "m-impl-1",
              },
              {
                id: 2126,
                command: "arc step foo done",
                output: "foo: step 1/2 closed (59117f62f)",
                exit_code: 0,
                cwd: projectDir,
                started_at_ms: T + 19_000,
                settled_at_ms: T + 19_000,
                anchor_msg_id: "m-impl-1",
              },
              {
                id: 2127,
                command: "arc step foo done",
                output: "foo: step 2/2 closed (a1b2c3d4e)",
                exit_code: 0,
                cwd: projectDir,
                started_at_ms: T + 39_000,
                settled_at_ms: T + 39_000,
                anchor_msg_id: "m-impl-2",
              },
            ],
          });

          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(ARC_NOTE_IN_TURN)}).length === 3`,
            { timeoutMs: 8000 },
          );

          // Nothing stranded: a row that found its turn is absorbed into it, and
          // the between-turns row is the seat a row with no turn takes.
          const stranded = await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(ARC_NOTE_BETWEEN_TURNS)}).length`,
          );
          expect(stranded, "every row found the turn its anchor names").toBe(0);

          // Each line's seat, named by the durable badge address of the entry it
          // renders inside. The seat is read off the row rather than from the
          // whole document in order, because the transcript is a windowed list:
          // three more rows is enough to carry the opening turn out of the
          // mounted range, and a document-order reading would then be measuring
          // the scroll position as much as the seating.
          const seated = JSON.parse(
            await app.evalJS<string>(
              `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(
                ARC_NOTE_IN_TURN,
              )})).map((el) => [(el.closest('[data-slot="tug-transcript-entry"]')?.querySelector('[data-slot="tug-transcript-entry-sequence"]')?.textContent || "").trim(), (el.textContent || "").trim()]))`,
            ),
          ) as Array<[string, string]>;

          // The implement segment's two turns, in the order the lines were
          // written — which is the whole of "seated exactly where they
          // appeared", now that nothing is stranded above the scroll.
          expect(
            seated.map(([address]) => address),
            "each line sits inside the turn whose span holds its clock, in message order",
          ).toEqual(["#a2", "#a2", "#a3"]);

          // And they are the right lines, in the order they were written.
          const notes = seated.map(([, text]) => text);
          expect(notes[0]).toContain("Step 1/2");
          expect(notes[1]).toContain("Step 1/2 closed");
          expect(notes[1]).toContain("59117f62f");
          expect(notes[2]).toContain("Step 2/2 closed");
          expect(notes[2]).toContain("a1b2c3d4e");
          // Every row names its arc, which is what a reader landing mid-scroll
          // has to have.
          for (const note of notes) expect(note).toContain("foo");

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
            document: ".tug/arcs/foo/plan.md",
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
        // well as on the live one, or every reopened arc relabels the words
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

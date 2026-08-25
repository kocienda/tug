/**
 * at0474-dash-arc-transcript.test.ts — a dash arc's stage rotation draws a
 * divider, and the transcript survives it, so the whole arc is one scroll
 * ([AT0474]).
 *
 * ## Why this exists
 *
 * A dash arc rotates a card onto a fresh claude session between stages
 * (devise → review → implement). tugcode announces each rotation with a
 * `session_stage` line and follows it with the fresh session's synthetic
 * `session_init`. Two things have to be true for the arc to read as one
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
 * **live render**: open a turn, inject a synthetic `session_stage` and the
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
const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const TUG_SESSION_ID = "test-session-A"; // bindSession default
const PROMPT = "write the brief";

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
      "a session_stage draws the boundary and the rows above it survive the rotation",
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
              type: "session_stage",
              tug_session_id: TUG_SESSION_ID,
              parentSessionId: "claude-parent",
              newSessionId: "claude-devise",
              stage: "devise",
              model: "opus",
              document: "dash/foo-brief.md",
              arc: "foo",
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
          expect(label).toContain("devise");
          expect(label).toContain("opus");
          expect(label).toContain("dash/foo-brief.md");

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
      "a lineage restore renders the arc's stages in order, dividers and all",
      async () => {
        // The restore leg. On relaunch tugcast hands tugcode the arc's whole
        // lineage and tugcode replays each stage's JSONL in turn, emitting a
        // `replay_stage` divider at every boundary — a separate wire type
        // from `session_stage`, because a replayed rotation is only a divider
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
            document: "dash/foo-brief.md",
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
  },
);

/**
 * at0474-arc-run-transcript-restore.test.ts — a restored arc reads as the
 * same one scroll it showed live ([AT0474]).
 *
 * An arc run rotates a card onto a fresh claude session between stages, and
 * live the rotation draws a stage divider with everything above it kept. On
 * relaunch the arc's whole lineage is replayed — one JSONL per stage, a
 * `replay_stage` divider at every boundary — and the card must end up
 * showing the same one scroll it showed live. The second test pins where
 * restored arc-note ink seats: inside the turns it narrated, across a
 * whole-line replay, never stacked above the transcript.
 *
 * One piece of the at0474-arc-run-transcript split ([B07] of the bodies
 * migration brief): `-rotation` carries the live rotation, `-interjection`
 * the user's message inside the wheel's turn. The shared constants are
 * `arc-run-transcript-fixture.ts`.
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
  ARC_NOTE_BETWEEN_TURNS,
  ARC_NOTE_IN_TURN,
  CODE_OUTPUT_FEED,
  DIVIDER,
  PROMPT,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  TUG_SESSION_ID,
  USER_ROW,
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
          await app.seedDeckState({ state: sessionCardShape(SESSION_CARD_SIZE_COMPACT), focusCardId: "A" });
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
              seq: 0,
              rev: 0,
              status: "complete",
              msg_id: msgId,
              block_index: 0,
              text: `re: ${text}`,
              is_partial: false,
            });
            await ingest({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success" });
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

          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(DIVIDER)}) !== null`,
            { timeoutMs: 6000 },
          );

          // Conversation → divider → devise, in that order, in one transcript.
          const order = JSON.parse(
            await app.body("A").evalJS<string>(
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
              seq: 0,
              rev: 0,
              status: "complete",
              msg_id: msgId,
              block_index: 0,
              text: `re: ${text}`,
              is_partial: false,
            });
            await ingest({ type: "turn_complete", seq: 0, msg_id: msgId, result: "success", timestamp: endedAt });
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
            document: ".tug/arcs/foo/tasks.md",
            arc: "foo",
          });
          await replaySpan("m-audit", "audit the branch", T + 50_000, T + 60_000);
          await ingest({ type: "replay_complete", count: 4 });

          await app.body("A").waitForCondition<boolean>(
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

          await app.body("A").waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(ARC_NOTE_IN_TURN)}).length === 3`,
            { timeoutMs: 8000 },
          );

          // Nothing stranded: a row that found its turn is absorbed into it, and
          // the between-turns row is the seat a row with no turn takes.
          const stranded = await app.body("A").evalJS<number>(
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
            await app.body("A").evalJS<string>(
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
  },
);

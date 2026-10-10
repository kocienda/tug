/**
 * Reducer tests for `handleTurnComplete`'s no-content fallback —
 * the branch that commits `pendingTurn` when `activeMsgId === null`.
 *
 * Under [D14], the reducer's `activeMsgId` is set only by the first
 * content event of a turn (`assistant_text` / `thinking_text` /
 * `tool_use` / `content_block_start`). Replay openers
 * (`handleAddUserMessage`, `handleWakeStarted`) DO NOT pre-bind it.
 *
 * The cold-boot JSONL replay translator's orphan-synthesis path emits
 * `turn_complete{msg_id: <synthesized>, result: "interrupted"}` when
 * a turn never reached the assistant side (transport loss between the
 * opener and the first content event). Today's translator synthesizes
 * `orphan-<n>` ids via `flushPendingOrphan`; Step 5.6's [D13] tracker
 * scheme synthesizes `u-<n>` / `w-<n>` via `openTurnMsgId`. Either
 * way, the synthesized id rides on the `turn_complete` frame and does
 * not match any `activeMsgId` value (none was set — no content).
 *
 * `handleTurnComplete`'s no-content fallback (#spec-reducer-state
 * rule 2) commits `pendingTurn` in this case, routing the
 * interrupted-before-response turn through the same commit path the
 * live wire uses. Without this fallback, the orphan turn_complete
 * would either drop (early-exit guard) or commit an empty TurnEntry
 * (`scratch.get("msg-orphan-1")` returns undefined → `messages: []`).
 *
 * This file pins the fallback explicitly so future changes to
 * `handleTurnComplete` cannot silently break it.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type {
  AppendTranscriptEffect,
  Effect,
} from "@/lib/code-session-store/effects";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

function applyAll(
  state: CodeSessionState,
  events: ReadonlyArray<CodeSessionEvent>,
): { state: CodeSessionState; effects: Effect[] } {
  let current = state;
  const collected: Effect[] = [];
  for (const ev of events) {
    const r = reduce(current, ev);
    current = r.state;
    collected.push(...r.effects);
  }
  return { state: current, effects: collected };
}

function appended(effects: ReadonlyArray<Effect>): AppendTranscriptEffect[] {
  return effects.filter(
    (e): e is AppendTranscriptEffect => e.kind === "append-transcript",
  );
}

describe("handleTurnComplete — no-content fallback (#spec-reducer-state rule 2)", () => {
  it("user-side orphan: add_user_message + orphan turn_complete (no content) commits pendingTurn with [user_message]", () => {
    // Simulates a cold-boot replay where a user JSONL entry has no
    // following assistant entry. Today's translator's flushPendingOrphan
    // emits `add_user_message` (text + attachments) followed by
    // `turn_complete{msg_id: orphan-N, result: "interrupted"}`. The
    // reducer's `activeMsgId` stays `null` (no content event ever
    // fired); the fallback commits `pendingTurn`.
    const initial = fresh();
    const { state: afterReplayStarted } = applyAll(initial, [
      { type: "replay_started" },
    ]);
    expect(afterReplayStarted.phase).toBe("replaying");

    const { state, effects } = applyAll(afterReplayStarted, [
      {
        type: "add_user_message",
        text: "did anyone hear me",
        atoms: [],
        turnKey: "tk-user-orphan",
      },
      {
        type: "turn_complete",
        msg_id: "orphan-0",
        result: "interrupted",
        seq: 0,
      },
    ]);

    // Exactly one TurnEntry committed via the no-content fallback.
    const turns = appended(effects);
    expect(turns).toHaveLength(1);
    const entry = turns[0].entry;

    // The committed turn carries the user_message Message from
    // `pendingTurn`'s scratch seed (handleAddUserMessage put it there).
    expect(entry.messages).toHaveLength(1);
    expect(entry.messages[0].kind).toBe("user_message");
    if (entry.messages[0].kind === "user_message") {
      expect(entry.messages[0].text).toBe("did anyone hear me");
    }

    // Result is interrupted (the orphan turn_complete carried it).
    expect(entry.result).toBe("interrupted");

    // State settles: pendingTurn cleared, activeMsgId stays null,
    // phase stays replaying (the bracket's replay_complete returns
    // it to idle).
    expect(state.pendingTurn).toBeNull();
    expect(state.activeMsgId).toBeNull();
    expect(state.phase).toBe("replaying");
  });

  it("wake-side orphan: wake_started + orphan turn_complete (no content) commits pendingTurn with []", () => {
    // Simulates a cold-boot replay where a wake bracket's
    // `<task-notification>` envelope arrives but no assistant entry
    // follows (transport loss mid-wake). The translator synthesizes
    // wake_started, then orphan turn_complete. The reducer's
    // pendingTurn is the wake bracket (isWake: true,
    // initialMessages: []); the fallback commits it.
    const initial = fresh();
    const { state: afterReplayStarted } = applyAll(initial, [
      { type: "replay_started" },
    ]);

    const { state, effects } = applyAll(afterReplayStarted, [
      {
        type: "wake_started",
        session_id: "sess-1",
        wake_trigger: {
          task_id: "wake-task-id",
          tool_use_id: "",
          status: "completed",
          summary: "scheduled wake",
          output_file: "",
        },
        turnKey: "tk-wake-orphan",
      },
      {
        type: "turn_complete",
        msg_id: "orphan-0",
        result: "interrupted",
        seq: 0,
      },
    ]);

    // Exactly one TurnEntry committed via the no-content fallback.
    const turns = appended(effects);
    expect(turns).toHaveLength(1);
    const entry = turns[0].entry;

    // Wake bracket commits with NO user_message Message — the wake
    // discriminator under [D07]. The only Message is the seeded
    // wake-trigger system_note (the trigger's summary); no content
    // event minted any assistant Message.
    expect(entry.messages).toHaveLength(1);
    expect(entry.messages[0]).toMatchObject({
      kind: "system_note",
      source: "scheduled",
      text: "scheduled wake",
    });

    // Result is interrupted.
    expect(entry.result).toBe("interrupted");

    // State settles.
    expect(state.pendingTurn).toBeNull();
    expect(state.activeMsgId).toBeNull();
  });

  it("synthesized opener id reaches committedMsgIds (one-shot; subsequent same-id is a no-op)", () => {
    // The fallback's committed turn adds the synthesized opener id
    // to committedMsgIds — the dedupe set. A second turn_complete
    // arriving with the same synthesized id (replay overlap, dev-tool
    // re-emission) is then a no-op rather than a duplicate commit.
    // Under [D14]'s assistant-side-only dedupe documentation, this
    // is acceptable: synthesized ids are unique-per-orphan-counter,
    // so collisions across orphans don't happen in normal operation.
    const initial = fresh();
    const { state: afterReplayStarted } = applyAll(initial, [
      { type: "replay_started" },
    ]);

    const { state: afterCommit, effects: firstEffects } = applyAll(
      afterReplayStarted,
      [
        {
          type: "add_user_message",
          text: "test orphan",
          atoms: [],
          turnKey: "tk-1",
        },
        {
          type: "turn_complete",
          msg_id: "orphan-7",
          result: "interrupted",
          seq: 0,
        },
      ],
    );

    expect(appended(firstEffects)).toHaveLength(1);
    expect(afterCommit.committedMsgIds.has("orphan-7")).toBe(true);

    // Replay the same orphan-7 turn_complete after committedMsgIds
    // has it. The dedupe path fires — no second TurnEntry appended,
    // pendingTurn (now null) stays null.
    const { state: afterDupe, effects: dupeEffects } = applyAll(
      afterCommit,
      [
        {
          type: "turn_complete",
          msg_id: "orphan-7",
          result: "interrupted",
          seq: 0,
        },
      ],
    );

    expect(appended(dupeEffects)).toHaveLength(0);
    expect(afterDupe.committedMsgIds.size).toBe(1);
  });

  it("stray turn_complete (no pendingTurn, no activeMsgId) drops without committing", () => {
    // Defensive: a turn_complete arriving with neither a pendingTurn
    // nor an activeMsgId is a translator regression or a wire-side
    // stray. Drop it (warn-and-no-op) rather than committing an empty
    // TurnEntry with whatever msg_id happened to be on the event.
    const initial = fresh();
    const { state: afterReplayStarted } = applyAll(initial, [
      { type: "replay_started" },
    ]);

    expect(afterReplayStarted.pendingTurn).toBeNull();
    expect(afterReplayStarted.activeMsgId).toBeNull();

    const { state, effects } = applyAll(afterReplayStarted, [
      {
        type: "turn_complete",
        msg_id: "orphan-stray",
        result: "interrupted",
        seq: 0,
      },
    ]);

    // No transcript commit; no state change beyond the drop.
    expect(appended(effects)).toHaveLength(0);
    expect(state.committedMsgIds.size).toBe(0);
    expect(state.pendingTurn).toBeNull();
    expect(state.activeMsgId).toBeNull();
  });

  it("with-content turn (live happy path): activeMsgId set by first content event, normal commit", () => {
    // Regression guard — the fallback must not capture the normal
    // commit path. A turn whose first content event set activeMsgId
    // commits via the existing match-by-activeMsgId branch, not via
    // the no-content fallback.
    const initial = fresh();
    const { state, effects } = applyAll(initial, [
      { type: "send", text: "hello", atoms: [], content: [{ type: "text" as const, text: "hello" }], turnKey: "tk-live" },
      {
        type: "assistant_text",
        msg_id: "msg_real",
        block_index: 0,
        text: "hi",
        is_partial: false,
        rev: 0,
        seq: 0,
        status: "complete",
      },
      { type: "turn_complete", msg_id: "msg_real", result: "success", seq: 0 },
    ]);

    const turns = appended(effects);
    expect(turns).toHaveLength(1);
    expect(turns[0].entry.result).toBe("success");
    expect(state.committedMsgIds.has("msg_real")).toBe(true);
    // Synthesized opener ids are NOT in committedMsgIds because no
    // orphan path fired in this scenario.
    expect(state.committedMsgIds.size).toBe(1);
  });
});

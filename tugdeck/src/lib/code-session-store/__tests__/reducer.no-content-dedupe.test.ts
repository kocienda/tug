/**
 * Reducer tests for `handleTurnComplete`'s dedupe gate against
 * no-content turns — the `/compact` / `/model` local-command shape.
 *
 * A local-command turn streams no assistant message, so claude never
 * reveals a `message.id` for it. Before tugcode stamped per-turn opener
 * ids (`t-<seq>`) on its terminal frames, every such turn's
 * `turn_complete` carried `msg_id: ""` — and the first one committed
 * `""` into `committedMsgIds`, making the dedupe gate swallow every
 * later no-content turn's commit. The observed failure was a `/model`
 * followed by a `/compact`: the compaction ran to completion on disk,
 * but its `turn_complete` was dropped as a "duplicate" — the `/compact`
 * row vanished from the card until a reload replayed it, and the phase
 * was stranded at `awaiting_first_token` ("Waiting") forever.
 *
 * Pins three behaviors:
 *   1. `""` is not an identity — never deduped on, never recorded.
 *   2. Opener-id (`t-<seq>`) no-content turns commit independently.
 *   3. A genuine duplicate drop normalizes a live in-flight phase back
 *      to `idle` instead of stranding it.
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

/**
 * One live local-command turn as the wire delivers it: the user's
 * submission, the synthesized stdout-echo text block, and the terminal
 * `turn_complete` — all sharing the turn's msg_id key.
 */
function localCommandTurn(
  text: string,
  turnKey: string,
  msgId: string,
  echoText: string,
): CodeSessionEvent[] {
  return [
    {
      type: "send",
      text,
      atoms: [],
      content: [{ type: "text" as const, text }],
      turnKey,
    },
    {
      type: "assistant_text",
      msg_id: msgId,
      block_index: 0,
      text: echoText,
      is_partial: false,
      rev: 0,
      seq: 0,
      status: "complete",
    },
    { type: "turn_complete", msg_id: msgId, result: "success", seq: 0 },
  ];
}

describe("handleTurnComplete — no-content-turn dedupe (the /compact-after-/model failure)", () => {
  it('legacy wire shape: two no-content turns both carrying msg_id "" commit independently', () => {
    // The pre-opener-id wire: both the /model and the /compact turn's
    // terminal frames ride msg_id "". The second commit must not be
    // swallowed as a duplicate of the first.
    const initial = fresh();

    const first = applyAll(
      initial,
      localCommandTurn("/model opus", "tk-model", "", "Set model to opus"),
    );
    expect(appended(first.effects)).toHaveLength(1);
    expect(first.state.phase).toBe("idle");
    // "" is not an identity — it never enters the dedupe set.
    expect(first.state.committedMsgIds.has("")).toBe(false);

    const second = applyAll(
      first.state,
      localCommandTurn("/compact", "tk-compact", "", "Compacted "),
    );
    const turns = appended(second.effects);
    expect(turns).toHaveLength(1);
    expect(turns[0].entry.result).toBe("success");
    // The turn settles fully: transcript row committed, phase idle,
    // nothing stranded in flight.
    expect(second.state.phase).toBe("idle");
    expect(second.state.pendingTurn).toBeNull();
    expect(second.state.activeMsgId).toBeNull();
  });

  it("opener-id wire shape: successive t-<seq> no-content turns commit under distinct identities", () => {
    const initial = fresh();

    const first = applyAll(
      initial,
      localCommandTurn("/model opus", "tk-model", "t-3", "Set model to opus"),
    );
    expect(appended(first.effects)).toHaveLength(1);
    expect(first.state.committedMsgIds.has("t-3")).toBe(true);

    const second = applyAll(
      first.state,
      localCommandTurn("/compact", "tk-compact", "t-9", "Compacted "),
    );
    expect(appended(second.effects)).toHaveLength(1);
    expect(second.state.phase).toBe("idle");
    expect(second.state.committedMsgIds.has("t-9")).toBe(true);
  });

  it("a genuine duplicate drop normalizes a live in-flight phase back to idle", () => {
    // A phantom cycle re-using an already-committed msg_id: its echo
    // advances the phase ladder (submitting → awaiting_first_token),
    // then its turn_complete is dropped by the dedupe gate. The drop
    // must not strand the phase — "Waiting" with no turn behind it is
    // the stuck state the user can only escape by reopening the card.
    const initial = fresh();

    const first = applyAll(initial, [
      {
        type: "send",
        text: "hello",
        atoms: [],
        content: [{ type: "text" as const, text: "hello" }],
        turnKey: "tk-1",
      },
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
    expect(first.state.committedMsgIds.has("msg_real")).toBe(true);

    const phantom = applyAll(first.state, [
      {
        type: "send",
        text: "again",
        atoms: [],
        content: [{ type: "text" as const, text: "again" }],
        turnKey: "tk-2",
      },
      {
        type: "assistant_text",
        msg_id: "msg_real",
        block_index: 0,
        text: "echo",
        is_partial: false,
        rev: 0,
        seq: 0,
        status: "complete",
      },
      { type: "turn_complete", msg_id: "msg_real", result: "success", seq: 0 },
    ]);

    // The duplicate commit is suppressed…
    expect(appended(phantom.effects)).toHaveLength(0);
    // …and the reducer settles instead of stranding an in-flight phase.
    expect(phantom.state.phase).toBe("idle");
    expect(phantom.state.pendingTurn).toBeNull();
  });
});

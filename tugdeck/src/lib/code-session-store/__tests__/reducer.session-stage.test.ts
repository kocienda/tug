/**
 * Reducer tests for `handleSessionStage` and the `stageNoteText` helper.
 *
 * A dash arc rotates a card onto a fresh claude session between stages. The
 * boundary is display-only: one `system_note` with `source: "stage"` and
 * nothing else moves — no phase change, no transcript clear, no compaction
 * state touched. The rotation happens at idle, so the ordinary path is the
 * effect: `append-stage-note`, which the store wrapper seats on the last
 * committed turn.
 *
 * Pins:
 *   - idle: state is reference-identical and exactly one `append-stage-note`
 *     effect carries the composed text,
 *   - mid-turn: the note lands in the open turn's scratch without displacing
 *     the `user_message`,
 *   - a continued implement stage reads its step range, en-dashed,
 *   - the compaction divider's text is unchanged by any of this.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import { stageNoteText } from "@/lib/code-session-store/stages";
import { TUG_ATOM_CHAR } from "@/lib/tug-atom-img";
import { compactionNoteText } from "@/lib/code-session-store/compaction";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function fresh(): CodeSessionState {
  return createInitialState(FIXTURE_IDS.TUG_SESSION_ID, "test", "new");
}

const SEND: CodeSessionEvent = {
  type: "send",
  text: "hi",
  atoms: [],
  content: [{ type: "text" as const, text: "hi" }],
  turnKey: "k1",
} as CodeSessionEvent;

function stage(
  name: string,
  model: string,
  document: string,
  steps?: string,
): CodeSessionEvent {
  return {
    type: "session_stage",
    stage: name,
    model,
    document,
    arc: "dash-arc",
    ...(steps !== undefined ? { steps } : {}),
  } as CodeSessionEvent;
}

describe("stageNoteText", () => {
  it("names the stage, the model, and the document", () => {
    expect(stageNoteText("devise", "opus", "dash/foo-brief.md")).toBe(
      "devise · opus · dash/foo-brief.md",
    );
  });

  it("names a continued implement stage by its step range, en-dashed", () => {
    expect(stageNoteText("implement", "sonnet", "dash/foo.md", "4-9")).toBe(
      "implement, continued · sonnet · steps 4–9",
    );
  });

  it("leaves out an empty model and an empty document rather than rendering a gap", () => {
    expect(stageNoteText("review", "", "dash/foo.md")).toBe("review · dash/foo.md");
    expect(stageNoteText("review", "", "")).toBe("review");
  });

  it("names a rotation with no course behind it by its stage and its model", () => {
    // A wheel rotation nobody is scoring carries no document, because
    // there is no course for it to have opened on. The divider is the label
    // and the model, and reads as a boundary all the same.
    expect(stageNoteText("review", "opus", "")).toBe("review · opus");
  });
});

describe("reducer — a rotation with no course behind it", () => {
  const courseless = (name: string, model: string): CodeSessionEvent =>
    ({
      type: "session_stage",
      stage: name,
      model,
      document: "",
      arc: "",
      prompt: "/tugplug:dash-review dash/foo.md",
      turnKey: "rot-k1",
    }) as CodeSessionEvent;

  it("folds into a divider and a wheel-origin turn, with no course anywhere in the path", () => {
    const { state: after, effects } = reduce(fresh(), courseless("review", "opus"));

    const note = effects.find((e) => e.kind === "append-stage-note");
    expect(note).toBeDefined();
    expect((note as { text?: string }).text).toBe("review · opus");
    expect(effects.some((e) => e.kind === "send-frame")).toBe(false);

    expect(after.pendingTurn?.turnKey).toBe("rot-k1");
    expect(after.pendingTurn?.origin).toBe("wheel");
  });
});

describe("reducer — a stage that carries its prompt", () => {
  it("opens the turn the deck will watch, without re-sending the prompt", () => {
    const before = fresh();
    const { state: after, effects } = reduce(before, {
      ...stage("devise", "opus", "dash/foo-brief.md"),
      prompt: "/tugplug:dash-devise dash/foo-brief.md",
      turnKey: "arc-k1",
    } as CodeSessionEvent);

    // The divider still lands on the committed transcript, ahead of the turn.
    expect(effects[0]?.kind).toBe("append-stage-note");
    // The runner already sent the prompt; the deck must not send it again.
    expect(effects.some((e) => e.kind === "send-frame")).toBe(false);

    // And the turn is open exactly as a typed one would be, so the stage's
    // frames have somewhere to land.
    expect(after.phase).toBe("submitting");
    expect(after.pendingTurn?.turnKey).toBe("arc-k1");
    // Nobody in the deck typed this: the row says the wheel did.
    expect(after.pendingTurn?.origin).toBe("wheel");
    // The prompt opens with a command the runner invoked, so it arrives as
    // a command atom rather than as characters — the same substrate the
    // composer submits for a typed command, and the same one replay
    // rebuilds from claude's `<command-name>` echo.
    const opener = after.scratch.get("arc-k1")?.messages[0];
    expect(opener?.kind).toBe("user_message");
    expect((opener as { text?: string }).text).toBe(
      `${TUG_ATOM_CHAR} dash/foo-brief.md`,
    );
    expect((opener as { attachments?: unknown[] }).attachments).toEqual([
      {
        kind: "atom",
        type: "command",
        label: "tugplug:dash-devise",
        value: "tugplug:dash-devise",
      },
    ]);
  });

  it("only annotates when a turn is already open — the prompt is queued behind it by claude", () => {
    const sent = reduce(fresh(), SEND).state;
    const { state: after, effects } = reduce(sent, {
      ...stage("review", "opus", "dash/foo.md"),
      prompt: "/tugplug:dash-review dash/foo.md",
      turnKey: "arc-k2",
    } as CodeSessionEvent);
    expect(effects.length).toBe(0);
    expect(after.pendingTurn?.turnKey).toBe("k1");
    expect(after.scratch.has("arc-k2")).toBe(false);
  });
});

/**
 * Wheel authorship is read off the frame, never worked out from a divider's
 * position. The reducer used to latch on a replayed `session_stage` and hand
 * that latch to whatever `add_user_message` came next — and because replay is
 * windowed, on a long run the divider fired and the first user message the
 * window happened to contain inherited the label: the user's own words,
 * attributed to the Wheel.
 */
describe("reducer — a replayed opener says who wrote it", () => {
  const addUser = (
    turnKey: string,
    text: string,
    origin?: "user" | "wheel",
  ): CodeSessionEvent =>
    ({
      type: "add_user_message",
      text,
      atoms: [],
      turnKey,
      ...(origin !== undefined ? { origin } : {}),
    }) as CodeSessionEvent;

  it("commits a wheel-origin turn when the frame says wheel", () => {
    const replaying = { ...fresh(), phase: "replaying" } as CodeSessionState;
    const opened = reduce(
      replaying,
      addUser("r1", "/tugplug:dash-devise dash/foo-brief.md", "wheel"),
    ).state;
    expect(opened.pendingTurn?.origin).toBe("wheel");
  });

  it("keeps an unmarked opener the user's even right after a stage divider", () => {
    // The exact regression, asserted in the shape that used to fail: a
    // divider arrives mid-replay, and the next frame — carrying no `origin`,
    // because its stage opener fell outside the window — is still the user's.
    const replaying = { ...fresh(), phase: "replaying" } as CodeSessionState;
    const divided = reduce(replaying, stage("devise", "opus", "dash/foo-brief.md")).state;
    const opened = reduce(divided, addUser("r1", "the user's own words")).state;
    expect(opened.pendingTurn?.origin).toBe("user");
  });

  it("keeps an unmarked opener the user's with no divider at all", () => {
    const replaying = { ...fresh(), phase: "replaying" } as CodeSessionState;
    const opened = reduce(replaying, addUser("r1", "hello")).state;
    expect(opened.pendingTurn?.origin).toBe("user");
  });

  it("leaves the live submit path exactly where it was", () => {
    // `handleSend` has always written `event.origin ?? "user"`, which is the
    // line the replay path now takes too — so the two agree by construction
    // rather than by two mechanisms kept in step.
    const typed = reduce(fresh(), SEND).state;
    expect(typed.pendingTurn?.origin).toBe("user");

    const seated = reduce(fresh(), {
      ...(SEND as Record<string, unknown>),
      origin: "wheel",
      turnKey: "k-wheel",
    } as CodeSessionEvent).state;
    expect(seated.pendingTurn?.origin).toBe("wheel");
  });
});

describe("reducer — handleSessionStage", () => {
  it("leaves state unchanged and emits one append-stage-note effect when idle", () => {
    const before = fresh();
    const { state: after, effects } = reduce(
      before,
      stage("devise", "opus", "dash/foo-brief.md"),
    );
    // The rotation happens at idle and the committed transcript lives in the
    // wrapper, not reducer state — so the reducer hands the divider off.
    expect(after).toBe(before);
    const notes = effects.filter((e) => e.kind === "append-stage-note");
    expect(notes.length).toBe(1);
    if (notes[0] && notes[0].kind === "append-stage-note") {
      expect(notes[0].text).toBe("devise · opus · dash/foo-brief.md");
    }
  });

  it("appends a stage system_note to the active turn mid-turn", () => {
    let s = fresh();
    s = reduce(s, SEND).state;
    s = reduce(s, {
      type: "assistant_text",
      msg_id: "m1",
      block_index: 0,
      text: "working",
      is_partial: true,
    } as CodeSessionEvent).state;
    const { state, effects } = reduce(s, stage("review", "opus", "dash/foo.md"));
    expect(effects.length).toBe(0);
    const entry = state.scratch.get("k1");
    expect(entry).toBeDefined();
    const note = entry!.messages.find((m) => m.kind === "system_note");
    expect(note).toBeDefined();
    if (note && note.kind === "system_note") {
      expect(note.source).toBe("stage");
      expect(note.text).toBe("review · opus · dash/foo.md");
    }
    // The opening user_message is still at the head, undisturbed.
    expect(entry!.messages[0]?.kind).toBe("user_message");
  });

  it("carries a continued implement stage's step range through to the note", () => {
    const { effects } = reduce(
      fresh(),
      stage("implement", "opus", "dash/foo.md", "4-9"),
    );
    const note = effects.find((e) => e.kind === "append-stage-note");
    expect(note).toBeDefined();
    if (note && note.kind === "append-stage-note") {
      expect(note.text).toBe("implement, continued · opus · steps 4–9");
    }
  });

  it("touches nothing but the divider — no phase change, no compaction state", () => {
    const before = fresh();
    const { state: after } = reduce(before, stage("devise", "", "dash/foo.md"));
    expect(after.phase).toBe(before.phase);
    expect(after.compactionSeed).toBe(before.compactionSeed);
    expect(after.scratch).toBe(before.scratch);
  });

  it("leaves the compaction divider's text unchanged", () => {
    expect(compactionNoteText(48_000)).toBe("Session compacted · ~48k tokens");
    expect(compactionNoteText()).toBe("Session compacted");
  });
});

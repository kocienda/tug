/**
 * Reducer tests for `handleArcNote` — the two seats an arc gesture's quiet
 * line ([P12]) can take.
 *
 * Mid-turn (the seated session ran the verb between two of its own tool
 * calls) the note appends to the active turn's scratch as a `system_note`
 * with `source: "arc"`, so it renders between the tool calls it arrived
 * among and commits with the turn. With no open turn (a hand-run verb, a
 * run-start line between stages) it falls back to its own quiet ink row —
 * an `ingest-ink-turn` effect whose entry carries the exchangeId the restore
 * path mints for the same ledger row, so a later ledger replay upserts the
 * same turn key instead of drawing the gesture twice.
 *
 * Pins:
 *   - mid-turn: a `source:"arc"` system_note is appended carrying the
 *     server-derived sentence verbatim, without displacing the opener,
 *   - two mid-turn notes take distinct message keys (the systemNoteSeq),
 *   - idle: state unchanged + one `ingest-ink-turn` effect whose sole
 *     message is a settled `arc …` shell exchange with the sentence as its
 *     output and the given exchangeId.
 */

import { describe, it, expect } from "bun:test";

import {
  reduce,
  createInitialState,
  type CodeSessionState,
} from "@/lib/code-session-store/reducer";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
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

function arcNote(text: string, exchangeId = "restored-7"): CodeSessionEvent {
  return {
    type: "arc_note",
    exchangeId,
    command: "arc step demo start",
    text,
    cwd: "/tmp/demo",
    timestamp: 1_700_000_000_000,
  };
}

describe("reducer — handleArcNote", () => {
  it("appends an arc system_note to the active turn mid-turn", () => {
    let s = fresh();
    s = reduce(s, SEND).state;
    const { state, effects } = reduce(s, arcNote("demo: step 1/3 started — carve"));
    expect(effects).toEqual([]);
    const entry = state.scratch.get("k1");
    expect(entry).toBeDefined();
    const note = entry!.messages.find((m) => m.kind === "system_note");
    expect(note).toBeDefined();
    if (note && note.kind === "system_note") {
      expect(note.source).toBe("arc");
      expect(note.text).toBe("demo: step 1/3 started — carve");
    }
    // The opening user_message is still at the head, undisturbed.
    expect(entry!.messages[0]?.kind).toBe("user_message");
  });

  it("keys each mid-turn note on its own ledger identity", () => {
    // Every note is its own ledger row, so keys derive from the exchangeId —
    // the identity `absorbArcNotes` dedups a post-relaunch replay against.
    let s = fresh();
    s = reduce(s, SEND).state;
    s = reduce(s, arcNote("demo: run declared through step 3", "restored-7")).state;
    s = reduce(s, arcNote("demo: step 1/3 started — carve", "restored-8")).state;
    const notes = s.scratch
      .get("k1")!
      .messages.filter((m) => m.kind === "system_note");
    expect(notes.length).toBe(2);
    expect(notes[0]!.messageKey).toBe("arc-note-restored-7");
    expect(notes[1]!.messageKey).toBe("arc-note-restored-8");
  });

  it("falls back to a quiet ink row when no turn is open", () => {
    const { state, effects } = reduce(fresh(), arcNote("demo: arc created"));
    expect(state.scratch.size).toBe(0);
    expect(effects.length).toBe(1);
    const effect = effects[0]!;
    if (effect.kind !== "ingest-ink-turn") {
      throw new Error(`expected ingest-ink-turn, got ${effect.kind}`);
    }
    expect(effect.entry.origin).toBe("shell");
    expect(effect.entry.turnKey).toBe("shell-restored-7");
    const msg = effect.entry.messages[0];
    expect(msg?.kind).toBe("shell_exchange");
    if (msg?.kind === "shell_exchange") {
      expect(msg.command).toBe("arc step demo start");
      expect(msg.output).toBe("demo: arc created");
      expect(msg.exitCode).toBe(0);
      expect(msg.settledAtMs).toBe(1_700_000_000_000);
    }
  });
});

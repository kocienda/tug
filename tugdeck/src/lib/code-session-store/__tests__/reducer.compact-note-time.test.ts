/**
 * The compaction divider never wears a fabricated time.
 *
 * A `compact_boundary` can beat a turn's first content block, which makes the
 * divider's `system_note` that turn's `messages[0]` — and `messages[0].createdAt`
 * is the committed transcript's sort key. Minting it `Date.now()` on replay
 * dated a historical turn to the relaunch, and because the interleave walk
 * stops at the first non-ink entry, that one turn walled every later replayed
 * turn behind it — burying the durable receipts beneath the wall (incident
 * seven, session direct-hero).
 *
 * Replayed boundaries carry the JSONL entry's own time; both note mints — the
 * open-turn scratch path and the no-open-turn `append-compact-note` effect —
 * must prefer it. Live boundaries carry none, and `Date.now()` is honest there.
 */
import { describe, expect, it } from "bun:test";

import { createInitialState, reduce } from "@/lib/code-session-store/reducer";
import type { AppendCompactNoteEffect } from "@/lib/code-session-store/effects";

const HISTORICAL = Date.parse("2026-08-23T18:05:48.000Z");

function opened() {
  return reduce(createInitialState("session", "test", "new"), {
    type: "send",
    text: "hi",
    atoms: [],
    content: [{ type: "text" as const, text: "hi" }],
    turnKey: "k",
  } as never).state;
}

describe("compact_boundary — the scratch-path note mint", () => {
  it("mints a replayed boundary's note at the entry's historical time", () => {
    const r = reduce(opened(), {
      type: "compact_boundary",
      preTokens: 48_000,
      timestamp: HISTORICAL,
    } as never);
    const scratch = r.state.scratch.get("k")!;
    const note = scratch.messages[scratch.messages.length - 1]!;
    expect(note.kind).toBe("system_note");
    expect(note.createdAt).toBe(HISTORICAL);
  });

  it("mints a live boundary's note at the wall clock, as it always did", () => {
    const before = Date.now();
    const r = reduce(opened(), {
      type: "compact_boundary",
      preTokens: 48_000,
    } as never);
    const scratch = r.state.scratch.get("k")!;
    const note = scratch.messages[scratch.messages.length - 1]!;
    expect(note.createdAt).toBeGreaterThanOrEqual(before);
    expect(note.createdAt).toBeLessThanOrEqual(Date.now());
  });
});

describe("compact_boundary — the no-open-turn effect path", () => {
  it("threads the replayed boundary's time onto the effect", () => {
    const r = reduce(createInitialState("session", "test", "new"), {
      type: "compact_boundary",
      preTokens: 48_000,
      timestamp: HISTORICAL,
    } as never);
    const effect = r.effects.find(
      (e): e is AppendCompactNoteEffect => e.kind === "append-compact-note",
    );
    expect(effect).toBeDefined();
    expect(effect!.timestamp).toBe(HISTORICAL);
  });

  it("omits the field for a live boundary", () => {
    const r = reduce(createInitialState("session", "test", "new"), {
      type: "compact_boundary",
      preTokens: 48_000,
    } as never);
    const effect = r.effects.find(
      (e): e is AppendCompactNoteEffect => e.kind === "append-compact-note",
    );
    expect(effect).toBeDefined();
    expect(effect!.timestamp).toBeUndefined();
  });
});

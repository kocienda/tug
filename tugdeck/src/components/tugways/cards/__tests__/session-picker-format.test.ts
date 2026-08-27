/**
 * session-picker-format — pure-logic tests for the picker's row copy.
 *
 * The dot-joined subtitle (`<when> · <turns> · <size> · id <short>`) is gone with
 * the metadata line it filled: those facts are the activity line's rest form now,
 * and its grammar is tested in `lib/__tests__/session-activity-line.test.ts`.
 * What survives here is the failed row's copy, whose whole point is that it does
 * not fabricate a cause.
 */

import { describe, expect, test } from "bun:test";

import { formatFailedRowSubtitle } from "../session-picker-format";
import type { SessionRow } from "@/protocol";

function row(over: Partial<SessionRow>): SessionRow {
  return {
    session_id: "abcdef1234567890",
    line_id: "line-abcdef12",
    workspace_key: "w",
    project_dir: "/p",
    created_at: 0,
    last_used_at: Date.now(), // → "just now", deterministic timestamp segment
    turn_count: 0,
    last_user_prompt: null,
    state: "closed",
    card_id: null,
    name: null,
    name_user_set: false,
    tag: null,
    synopsis: null,
    origin: "external",
    terminal_live: null,
    ...over,
  };
}

describe("formatFailedRowSubtitle — no fabricated cause", () => {
  test("an intact on-disk transcript invites a retry, never claims missing", () => {
    // The commit-xp regression: a 40 MB transcript on disk while the row
    // announced "JSONL missing".
    const s = formatFailedRowSubtitle(row({ state: "failed", file_size: 40_000_000 }));
    expect(s).toBe("Resume failed — select to retry");
  });

  test("an unscanned row (file_size absent) does not assert missing", () => {
    const s = formatFailedRowSubtitle(row({ state: "failed" }));
    expect(s).toBe("Resume failed — select to retry");
  });

  test("only a scanned-empty transcript (file_size 0) claims missing", () => {
    const s = formatFailedRowSubtitle(row({ state: "failed", file_size: 0 }));
    expect(s).toBe("Couldn’t resume — transcript missing");
  });
});

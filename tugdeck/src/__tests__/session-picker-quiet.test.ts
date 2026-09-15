/**
 * session-picker-quiet.test.ts — when the Choose Session picker's content
 * has stopped moving, for a card that arrived hidden ([B03], [F01], [F03]).
 *
 * `pickerContentQuiet` is pure over a workspace snapshot and a synopsis
 * lookup, and the cases below are the listing's two frames as the host
 * actually emits them: phase one with `scanning: true` and the ledger's rows,
 * phase two with the union and `scanning: false`. The claim is the rule's,
 * not the picker's rendering: which frames a hidden card may reveal over.
 */

import { describe, expect, test } from "bun:test";

import {
  PICKER_ROWS_TO_FILL_CAP,
  pickerContentQuiet,
} from "@/components/tugways/cards/session-picker-quiet";
import type { WorkspaceSnapshot } from "@/lib/session-ledger-store";
import type { SessionRow } from "@/protocol";

/** A row with resumable content — a turn behind it — and a synopsis or not. */
function row(n: number, opts: { synopsis?: boolean; empty?: boolean } = {}): SessionRow {
  return {
    session_id: `s-${n}`,
    line_id: `line-${n}`,
    workspace_key: "ws",
    project_dir: "/p",
    created_at: n,
    last_used_at: n,
    turn_count: opts.empty === true ? 0 : 3,
    last_user_prompt: null,
    state: "closed",
    card_id: null,
    background: false,
    name: null,
    name_user_set: false,
    tag: null,
    synopsis: opts.synopsis === true ? `about ${n}` : null,
    origin: "tug",
    terminal_live: null,
  };
}

function ready(rows: SessionRow[], scanning: boolean): WorkspaceSnapshot {
  return { status: "ready", rows, scanning };
}

/** Synopses as the store would answer: present exactly for rows that carry one. */
function synopsesOf(rows: SessionRow[]): (lineId: string) => boolean {
  const have = new Set(rows.filter((r) => r.synopsis !== null).map((r) => r.line_id));
  return (lineId) => have.has(lineId);
}

describe("pickerContentQuiet", () => {
  test("a pending listing is never quiet — it is the placeholder the rows replace", () => {
    expect(pickerContentQuiet({ status: "pending", rows: [] }, () => true)).toBe(false);
    expect(pickerContentQuiet({ status: "idle", rows: [] }, () => true)).toBe(false);
  });

  test("an error listing is quiet — the notice is the settled form", () => {
    expect(pickerContentQuiet({ status: "error", rows: [] }, () => false)).toBe(true);
  });

  test("phase one with a short list is not quiet: phase two can still add rows", () => {
    const rows = [row(1, { synopsis: true }), row(2, { synopsis: true })];
    expect(pickerContentQuiet(ready(rows, true), synopsesOf(rows))).toBe(false);
  });

  test("phase two settles a short list", () => {
    const rows = [row(1, { synopsis: true }), row(2, { synopsis: true })];
    expect(pickerContentQuiet(ready(rows, false), synopsesOf(rows))).toBe(true);
  });

  test("phase one already filling the cap is quiet — no later frame can change the height", () => {
    // Four rows plus the "New session" row the list leads with fill the
    // 14.5rem cap over a 3.5rem row floor ([F03]); the scan may still be
    // running, and it does not matter.
    const rows = Array.from({ length: PICKER_ROWS_TO_FILL_CAP - 1 }, (_, i) =>
      row(i, { synopsis: true }),
    );
    expect(pickerContentQuiet(ready(rows, true), synopsesOf(rows))).toBe(true);
  });

  test("rows without content do not count toward the cap", () => {
    // An empty session is hidden by the picker, so it fills nothing.
    const rows = [
      ...Array.from({ length: PICKER_ROWS_TO_FILL_CAP - 2 }, (_, i) =>
        row(i, { synopsis: true }),
      ),
      row(99, { empty: true, synopsis: true }),
    ];
    expect(pickerContentQuiet(ready(rows, true), synopsesOf(rows))).toBe(false);
  });

  test("a settled list whose on-screen row lacks its synopsis is not quiet", () => {
    // The description line is what a synopsis fills; a row whose synopsis
    // lands late is a row that changes height.
    const rows = [row(1, { synopsis: true }), row(2)];
    expect(pickerContentQuiet(ready(rows, false), synopsesOf(rows))).toBe(false);
  });

  test("a missing synopsis BELOW the fold does not hold the reveal", () => {
    // Only the rows on screen can move what the eye sees.
    const onScreen = Array.from({ length: PICKER_ROWS_TO_FILL_CAP - 1 }, (_, i) =>
      row(i, { synopsis: true }),
    );
    const rows = [...onScreen, row(50), row(51)];
    expect(pickerContentQuiet(ready(rows, false), synopsesOf(rows))).toBe(true);
  });

  test("a settled listing with no rows at all is quiet", () => {
    expect(pickerContentQuiet(ready([], false), () => false)).toBe(true);
  });
});

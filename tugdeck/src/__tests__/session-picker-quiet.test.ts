/**
 * session-picker-quiet.test.ts — when the Choose Session picker's content
 * has stopped moving, for a card that arrived hidden ([B03], [F01], [F03]).
 *
 * `pickerContentQuiet` is pure over the picker's groups — which are unfolded,
 * and each open one's listing — and a synopsis lookup. The cases below are a
 * listing's two frames as the host actually emits them: phase one with
 * `scanning: true` and the ledger's rows, phase two with the union and
 * `scanning: false`. The claim is the rule's, not the picker's rendering:
 * which frames a hidden card may reveal over.
 */

import { describe, expect, test } from "bun:test";

import {
  PICKER_ROWS_TO_FILL_CAP,
  pickerContentQuiet,
  type QuietGroup,
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

/** One open group over `snapshot`. */
function open(snapshot: WorkspaceSnapshot): QuietGroup {
  return { open: true, snapshot };
}

/** A folded group: its band alone, its listing unread. */
const FOLDED: QuietGroup = { open: false, snapshot: null };

/** Synopses as the store would answer: present exactly for rows that carry one. */
function synopsesOf(rows: SessionRow[]): (lineId: string) => boolean {
  const have = new Set(rows.filter((r) => r.synopsis !== null).map((r) => r.line_id));
  return (lineId) => have.has(lineId);
}

/**
 * How many session rows fill the cap under one open group: the group's band
 * and its New session row stand in the list too.
 */
const SESSIONS_TO_FILL = PICKER_ROWS_TO_FILL_CAP - 2;

describe("pickerContentQuiet", () => {
  test("a pending open group is never quiet — it is the placeholder the rows replace", () => {
    expect(pickerContentQuiet([open({ status: "pending", rows: [] })], () => true)).toBe(false);
    expect(pickerContentQuiet([open({ status: "idle", rows: [] })], () => true)).toBe(false);
  });

  test("an error listing is quiet — the band's note is the settled form", () => {
    expect(pickerContentQuiet([open({ status: "error", rows: [] })], () => false)).toBe(true);
  });

  test("a folded group's listing does not hold the reveal", () => {
    // A folded group is its band, the same height pending or settled.
    const rows = [row(1, { synopsis: true })];
    expect(pickerContentQuiet([open(ready(rows, false)), FOLDED], synopsesOf(rows))).toBe(true);
  });

  test("every open group must settle, not only the first", () => {
    const rows = [row(1, { synopsis: true })];
    expect(
      pickerContentQuiet(
        [open(ready(rows, false)), open({ status: "pending", rows: [] })],
        synopsesOf(rows),
      ),
    ).toBe(false);
  });

  test("phase one with a short list is not quiet: phase two can still add rows", () => {
    const rows = [row(1, { synopsis: true }), row(2, { synopsis: true })];
    expect(pickerContentQuiet([open(ready(rows, true))], synopsesOf(rows))).toBe(false);
  });

  test("phase two settles a short list", () => {
    const rows = [row(1, { synopsis: true }), row(2, { synopsis: true })];
    expect(pickerContentQuiet([open(ready(rows, false))], synopsesOf(rows))).toBe(true);
  });

  test("phase one already filling the cap is quiet — no later frame can change the height", () => {
    const rows = Array.from({ length: SESSIONS_TO_FILL }, (_, i) => row(i, { synopsis: true }));
    expect(pickerContentQuiet([open(ready(rows, true))], synopsesOf(rows))).toBe(true);
  });

  test("folded bands count toward the cap — they stand in the list", () => {
    const rows = Array.from({ length: SESSIONS_TO_FILL - 2 }, (_, i) =>
      row(i, { synopsis: true }),
    );
    expect(
      pickerContentQuiet([open(ready(rows, true)), FOLDED, FOLDED], synopsesOf(rows)),
    ).toBe(true);
  });

  test("rows without content do not count toward the cap", () => {
    // An empty session is hidden by the picker, so it fills nothing.
    const rows = [
      ...Array.from({ length: SESSIONS_TO_FILL - 1 }, (_, i) => row(i, { synopsis: true })),
      row(99, { empty: true, synopsis: true }),
    ];
    expect(pickerContentQuiet([open(ready(rows, true))], synopsesOf(rows))).toBe(false);
  });

  test("a settled list is quiet even when an on-screen row lacks its synopsis", () => {
    const rows = [row(1, { synopsis: true }), row(2)];
    expect(pickerContentQuiet([open(ready(rows, false))], synopsesOf(rows))).toBe(true);
  });

  test("a scanning list at its cap still waits for its on-screen synopses", () => {
    const rows = Array.from({ length: SESSIONS_TO_FILL }, (_, i) =>
      row(i, { synopsis: i !== 1 }),
    );
    expect(pickerContentQuiet([open(ready(rows, true))], synopsesOf(rows))).toBe(false);
  });

  test("a missing synopsis BELOW the fold does not hold the reveal", () => {
    // Only the rows on screen can move what the eye sees.
    const onScreen = Array.from({ length: SESSIONS_TO_FILL }, (_, i) =>
      row(i, { synopsis: true }),
    );
    const rows = [...onScreen, row(50), row(51)];
    expect(pickerContentQuiet([open(ready(rows, true))], synopsesOf(rows))).toBe(true);
  });

  test("a settled listing with no rows at all is quiet", () => {
    expect(pickerContentQuiet([open(ready([], false))], () => false)).toBe(true);
  });
});

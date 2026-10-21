/**
 * Unit tests for the Choose Session sheet's list rows and the selection that
 * walks them.
 *
 * Two things are under test. Which rows stand: a group shows its band, an
 * unfolded one its New session row and its sessions, and a filter trades the
 * structure for the matches. And where Open goes when the reader's pick is no
 * longer on screen: never to something hidden, and with nothing picked, to
 * the first group's New session row — the project the sheet opens on.
 */

import { describe, expect, it } from "bun:test";

import type { SessionRow } from "@/protocol";

import { pickerGroupFrom, type PickerGroup } from "../session-picker-groups";
import {
  effectiveSelection,
  pickerRowId,
  pickerRowsFrom,
  type PickerRow,
} from "../session-picker-rows";

function row(id: string, prompt: string, opts: { live?: boolean } = {}): SessionRow {
  return {
    session_id: id,
    line_id: id,
    workspace_key: "w",
    project_dir: "/p",
    created_at: 0,
    last_used_at: 0,
    turn_count: 2,
    last_user_prompt: prompt,
    state: opts.live === true ? "live" : "closed",
    card_id: null,
    background: false,
    name: null,
    name_user_set: false,
    tag: id,
    synopsis: null,
    origin: "tug",
    terminal_live: null,
    file_size: 10,
  } as SessionRow;
}

function group(
  dir: string,
  rows: SessionRow[],
  opts: { inWorkspace?: boolean; status?: "pending" | "missing" } = {},
): PickerGroup {
  return pickerGroupFrom(
    { projectDir: dir, inWorkspace: opts.inWorkspace ?? false },
    opts.status === "pending"
      ? { status: "pending", rows: [] }
      : { status: "ready", rows, dirExists: opts.status !== "missing" },
  );
}

const ids = (rows: readonly PickerRow[]): string[] => rows.map(pickerRowId);

const TUG = group("/src/tug", [row("t1", "fold the band"), row("t2", "heron audit")], {
  inWorkspace: true,
});
const EUCIT = group("/src/eucit", [row("e1", "heron register"), row("e2", "people index")]);
const GONE = group("/src/gone", [], { status: "missing" });
const WAITING = group("/src/waiting", [], { status: "pending" });

const openOnly =
  (...dirs: string[]) =>
  (dir: string): boolean =>
    dirs.includes(dir);

describe("pickerRowsFrom — the rows the list shows", () => {
  it("shows every band, an open group's New session row and sessions, and ends on the other-folder row", () => {
    expect(ids(pickerRowsFrom([TUG, EUCIT], openOnly("/src/tug"), ""))).toEqual([
      "group:/src/tug",
      "new:/src/tug",
      "resume:t1",
      "resume:t2",
      "group:/src/eucit",
      "other",
    ]);
  });

  it("gives a missing folder no New session row — there is nowhere to start one", () => {
    expect(ids(pickerRowsFrom([GONE], openOnly("/src/gone"), ""))).toEqual([
      "group:/src/gone",
      "other",
    ]);
  });

  it("lets a pending group offer its New session row before its sessions arrive", () => {
    expect(ids(pickerRowsFrom([WAITING], openOnly("/src/waiting"), ""))).toEqual([
      "group:/src/waiting",
      "new:/src/waiting",
      "other",
    ]);
  });

  it("under a filter unfolds every group with a match, hides the rest, and drops the New and other rows", () => {
    // EUCIT is folded, and the filter opens it anyway: the reader asked for rows.
    expect(ids(pickerRowsFrom([TUG, EUCIT, GONE], openOnly("/src/tug"), "heron"))).toEqual([
      "group:/src/tug",
      "resume:t2",
      "group:/src/eucit",
      "resume:e1",
    ]);
  });

  it("yields no rows at all when nothing matches", () => {
    expect(pickerRowsFrom([TUG, EUCIT], openOnly("/src/tug"), "zebra")).toEqual([]);
  });
});

describe("effectiveSelection — where Open goes", () => {
  const rows = pickerRowsFrom([TUG, EUCIT], openOnly("/src/tug"), "");

  it("with nothing picked, is the first group's New session row", () => {
    expect(effectiveSelection(rows, null)).toEqual({
      kind: "session-new",
      projectDir: "/src/tug",
    });
  });

  it("keeps a pick the list still shows", () => {
    const pick = { kind: "session-resume", projectDir: "/src/tug", sessionId: "t2" } as const;
    expect(effectiveSelection(rows, pick)).toBe(pick);
    const band = { kind: "group", projectDir: "/src/eucit" } as const;
    expect(effectiveSelection(rows, band)).toBe(band);
  });

  it("falls back to the pick's own project's New session row when its row is hidden", () => {
    const hidden = { kind: "session-resume", projectDir: "/src/tug", sessionId: "gone" } as const;
    expect(effectiveSelection(rows, hidden)).toEqual({
      kind: "session-new",
      projectDir: "/src/tug",
    });
  });

  it("under a filter, falls to the first match — never to a row the reader cannot see", () => {
    const filtered = pickerRowsFrom([TUG, EUCIT], openOnly("/src/tug"), "register");
    expect(effectiveSelection(filtered, { kind: "session-new", projectDir: "/src/tug" })).toEqual({
      kind: "session-resume",
      projectDir: "/src/eucit",
      sessionId: "e1",
    });
  });

  it("never picks a live session", () => {
    const live = group("/src/live", [row("l1", "busy", { live: true })]);
    const only = pickerRowsFrom([live], openOnly("/src/live"), "busy");
    expect(effectiveSelection(only, null)).toBeNull();
  });
});

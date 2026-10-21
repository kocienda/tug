/**
 * Unit tests for the Choose Session sheet's group set and each group's facts.
 *
 * The group set is the fix for a new session landing in the wrong project: the
 * workspace's own projects lead, the recents follow, and a path is shown once.
 * Each group's facts come from its own listing, so a group still waiting on
 * its `list_sessions` says so rather than reading as empty, and a missing
 * directory outranks whatever the listing holds.
 */

import { describe, expect, it } from "bun:test";

import type { WorkspaceSnapshot } from "@/lib/session-ledger-store";
import type { SessionRow } from "@/protocol";

import {
  defaultOpenDirs,
  isRecentGroup,
  pickerGroupFrom,
  pickerGroupSpecsFrom,
} from "../session-picker-groups";

function row(id: string, opts: { live?: boolean; terminal?: boolean } = {}): SessionRow {
  return {
    session_id: id,
    line_id: id,
    workspace_key: "w",
    project_dir: "/p",
    created_at: 0,
    last_used_at: 0,
    turn_count: 1,
    last_user_prompt: "hello",
    state: opts.live === true ? "live" : "closed",
    card_id: null,
    background: false,
    name: null,
    name_user_set: false,
    tag: id,
    synopsis: null,
    origin: "tug",
    terminal_live: opts.terminal === true ? ({} as SessionRow["terminal_live"]) : null,
    file_size: 0,
  } as SessionRow;
}

describe("pickerGroupSpecsFrom — which projects the sheet shows", () => {
  it("puts the workspace's projects first, then the recents not already shown", () => {
    expect(
      pickerGroupSpecsFrom(["/tug", "/eucit"], ["/notes", "/tug", "/site"]),
    ).toEqual([
      { projectDir: "/tug", inWorkspace: true },
      { projectDir: "/eucit", inWorkspace: true },
      { projectDir: "/notes", inWorkspace: false },
      { projectDir: "/site", inWorkspace: false },
    ]);
  });

  it("keeps the recents' stored order when no card is bound", () => {
    expect(pickerGroupSpecsFrom([], ["/b", "/a"])).toEqual([
      { projectDir: "/b", inWorkspace: false },
      { projectDir: "/a", inWorkspace: false },
    ]);
  });

  it("falls back to the default project when no card is bound and there are no recents", () => {
    expect(pickerGroupSpecsFrom([], [], "/default")).toEqual([
      { projectDir: "/default", inWorkspace: false, fallback: true },
    ]);
    // Either list naming a project is enough to leave the fallback out.
    expect(pickerGroupSpecsFrom([], ["/recent"], "/default")).toEqual([
      { projectDir: "/recent", inWorkspace: false },
    ]);
  });

  it("lists a typed folder last, and only once", () => {
    expect(pickerGroupSpecsFrom(["/tug"], ["/notes"], "", "/elsewhere")).toEqual([
      { projectDir: "/tug", inWorkspace: true },
      { projectDir: "/notes", inWorkspace: false },
      { projectDir: "/elsewhere", inWorkspace: false, typed: true },
    ]);
    expect(pickerGroupSpecsFrom(["/tug"], [], "", "/tug")).toEqual([
      { projectDir: "/tug", inWorkspace: true },
    ]);
  });

  it("drops empty paths and repeats within a list", () => {
    expect(pickerGroupSpecsFrom(["", "/a", "/a"], ["/b", "", "/b"])).toEqual([
      { projectDir: "/a", inWorkspace: true },
      { projectDir: "/b", inWorkspace: false },
    ]);
  });

  it("makes one group of two spellings of one directory, under its canonical spelling", () => {
    // The screenshot's case: the workspace's card bound under the long
    // spelling, a recent under the short symlink — one project ([L29]).
    const canonical: Record<string, string> = {
      "/u/src/tug": "/Users/k/Mounts/u/src/tug",
      "/Users/k/Mounts/u/src/tug": "/Users/k/Mounts/u/src/tug",
      "/Users/k/eucit": "/Users/k/eucit",
    };
    const canonicalOf = (p: string): string => canonical[p] ?? p;
    expect(
      pickerGroupSpecsFrom(
        ["/Users/k/Mounts/u/src/tug"],
        ["/Users/k/eucit", "/u/src/tug"],
        "",
        "/u/src/tug",
        canonicalOf,
      ),
    ).toEqual([
      { projectDir: "/Users/k/Mounts/u/src/tug", inWorkspace: true },
      { projectDir: "/Users/k/eucit", inWorkspace: false },
    ]);
  });

  it("marks a path the server has not answered for as unresolved, under its own spelling", () => {
    // Until the answer lands the group is drawn pending and lists nothing, so
    // no listing is keyed on a spelling the answer would replace ([L29]).
    const canonicalOf = (p: string): string | undefined =>
      p === "/Users/k/eucit" ? "/Users/k/eucit" : undefined;
    expect(pickerGroupSpecsFrom([], ["/Users/k/eucit", "/u/src/tug"], "", "", canonicalOf)).toEqual([
      { projectDir: "/Users/k/eucit", inWorkspace: false },
      { projectDir: "/u/src/tug", inWorkspace: false, unresolved: true },
    ]);
  });
});

describe("isRecentGroup — which bands offer to leave the recents", () => {
  it("is only the recents: not the workspace's, the typed folder, or the fallback", () => {
    const [workspace, recent, typed] = pickerGroupSpecsFrom(["/tug"], ["/notes"], "", "/elsewhere");
    expect(isRecentGroup(workspace)).toBe(false);
    expect(isRecentGroup(recent)).toBe(true);
    expect(isRecentGroup(typed)).toBe(false);
    // The fallback stands in for an empty recents list, so removing it from
    // that list would do nothing.
    const [fallback] = pickerGroupSpecsFrom([], [], "/default");
    expect(isRecentGroup(fallback)).toBe(false);
  });
});

describe("pickerGroupFrom — a group's facts from its listing", () => {
  const spec = { projectDir: "/Users/k/src/tug", inWorkspace: true };

  it("names the project by its last path segment", () => {
    const group = pickerGroupFrom(spec, { status: "pending", rows: [] });
    expect(group.name).toBe("tug");
  });

  it("reads as pending, with no rows, until the listing settles", () => {
    const group = pickerGroupFrom(spec, { status: "pending", rows: [row("a")] });
    expect(group.status).toBe("pending");
    expect(group.rows).toEqual([]);
    expect(group.live).toBe(0);
  });

  it("counts live sessions — in Tug or a terminal — apart from the trashable rest", () => {
    const snapshot: WorkspaceSnapshot = {
      status: "ready",
      dirExists: true,
      rows: [row("a", { live: true }), row("b", { terminal: true }), row("c"), row("d")],
    };
    const group = pickerGroupFrom(spec, snapshot);
    expect(group.status).toBe("ready");
    expect(group.rows).toHaveLength(4);
    expect(group.listed).toHaveLength(4);
    expect(group.live).toBe(2);
    expect(group.trashable).toBe(2);
  });

  it("says missing when the host reports no such directory, whatever the rows", () => {
    const group = pickerGroupFrom(spec, {
      status: "ready",
      dirExists: false,
      rows: [row("a")],
    });
    expect(group.status).toBe("missing");
    expect(group.rows).toEqual([]);
  });

  it("says error when the listing failed", () => {
    const group = pickerGroupFrom(spec, {
      status: "error",
      rows: [],
      error: { reason: "boom" },
    });
    expect(group.status).toBe("error");
  });
});

describe("defaultOpenDirs — which groups open unfolded", () => {
  it("opens the workspace's groups", () => {
    expect(
      defaultOpenDirs(pickerGroupSpecsFrom(["/a", "/b"], ["/c"])),
    ).toEqual(["/a", "/b"]);
  });

  it("opens the first group when no card is bound", () => {
    expect(defaultOpenDirs(pickerGroupSpecsFrom([], ["/c", "/d"]))).toEqual(["/c"]);
  });
});

describe("pickerGroupFrom — what the list shows of a listing", () => {
  it("leaves an empty session out of the rows but keeps it for the Trash sweep", () => {
    const empty = { ...row("x"), turn_count: 0, file_size: 0 } as SessionRow;
    const group = pickerGroupFrom(
      { projectDir: "/p", inWorkspace: false },
      { status: "ready", dirExists: true, rows: [row("a"), empty] },
    );
    expect(group.rows.map((r) => r.session_id)).toEqual(["a"]);
    expect(group.listed.map((r) => r.session_id)).toEqual(["a", "x"]);
  });
});

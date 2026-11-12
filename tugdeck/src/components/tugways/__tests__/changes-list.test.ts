import { describe, expect, it } from "bun:test";

import {
  diffablePathsOf,
  entryDiffDescriptor,
  fileExpandKey,
  projectLeaf,
  sharedIsReleasable,
  sharedWithTitle,
  type ChangesListEntry,
} from "@/components/tugways/cards/session-changes/changes-list";
import type {
  ChangesetFile,
  ProjectChangeset,
  SessionChangesetEntry,
  SharedOwner,
  UnattributedFile,
} from "@/lib/changeset-types";

function project(overrides: Partial<ProjectChangeset> = {}): ProjectChangeset {
  return {
    workspace_key: "ws",
    branch: "main",
    ahead: 0,
    behind: 0,
    head_sha: "0".repeat(40),
    head_message: "head",
    changesets: [],
    unattributed: [],
    project_dir: "/repo",
    display_name: "repo",
    no_repo: false,
    ...overrides,
  };
}

function file(path: string, git_status: string): ChangesetFile {
  return { path, git_status, op: "modified", origin: "turn", shared: false, last_touched: 0 };
}

function sessionEntry(files: ChangesetFile[]): SessionChangesetEntry {
  return { kind: "session", owner_id: "own", display_name: "own", live: true, files };
}

function sessionItem(files: ChangesetFile[], proj = project()): ChangesListEntry {
  return { kind: "session", id: "sess", project: proj, entry: sessionEntry(files) };
}

function unattributedItem(files: UnattributedFile[], proj = project()): ChangesListEntry {
  return { kind: "unattributed", id: "unattr", project: proj, files };
}

describe("fileExpandKey", () => {
  it("joins entry id and path with a pipe", () => {
    expect(fileExpandKey("sess", "src/a.ts")).toBe("sess|src/a.ts");
  });
});

describe("diffablePathsOf", () => {
  it("keeps every path — untracked files diff via synthesized new-file diffs", () => {
    const item = sessionItem([file("a.ts", ".M"), file("new.ts", "??"), file("b.ts", "A.")]);
    expect(diffablePathsOf(item)).toEqual(["a.ts", "new.ts", "b.ts"]);
  });

  it("reads from the files array for an unattributed entry", () => {
    const item = unattributedItem([
      { path: "u.ts", git_status: ".M" },
      { path: "fresh.ts", git_status: "??" },
    ]);
    expect(diffablePathsOf(item)).toEqual(["u.ts", "fresh.ts"]);
  });
});

describe("entryDiffDescriptor", () => {
  it("returns a head descriptor scoped to every path, untracked included", () => {
    const item = sessionItem([file("a.ts", ".M"), file("new.ts", "??")]);
    expect(entryDiffDescriptor(item)).toEqual({
      kind: "head",
      root: "/repo",
      paths: ["a.ts", "new.ts"],
    });
  });

  it("returns null for an empty entry", () => {
    expect(entryDiffDescriptor(sessionItem([]))).toBeNull();
  });

  it("returns null for a non-repo project", () => {
    const item = sessionItem([file("a.ts", ".M")], project({ no_repo: true }));
    expect(entryDiffDescriptor(item)).toBeNull();
  });
});

function sharedFile(shared_with: SharedOwner[] | undefined, shared = true) {
  return { shared, shared_with };
}

describe("sharedWithTitle", () => {
  it("names one co-owner", () => {
    expect(sharedWithTitle(sharedFile([{ id: "s1", name: "alpha", live: true }]))).toBe(
      "shared with alpha",
    );
  });

  it("names several, in the order the server sent them", () => {
    expect(
      sharedWithTitle(
        sharedFile([
          { id: "s1", name: "alpha", live: true },
          { id: "s2", name: "beta", live: true },
        ]),
      ),
    ).toBe("shared with alpha, beta");
  });

  it("marks a closed co-owner — the whole point of naming it", () => {
    expect(
      sharedWithTitle(
        sharedFile([
          { id: "s1", name: "alpha", live: true },
          { id: "s2", name: "probe", live: false },
        ]),
      ),
    ).toBe("shared with alpha, probe (closed)");
  });

  it("has nothing to say without the field — a pre-plan server", () => {
    expect(sharedWithTitle(sharedFile(undefined))).toBeNull();
    expect(sharedWithTitle(sharedFile([]))).toBeNull();
  });

  it("has nothing to say about an unshared file", () => {
    expect(
      sharedWithTitle(sharedFile([{ id: "s1", name: "alpha", live: true }], false)),
    ).toBeNull();
  });
});

describe("projectLeaf", () => {
  it("names a project by its last component, trailing slashes ignored", () => {
    expect(projectLeaf("/Users/k/Mounts/u/vids")).toBe("vids");
    expect(projectLeaf("/Users/k/Mounts/u/vids/")).toBe("vids");
  });

  it("has nothing to say for an absent or rootless path", () => {
    expect(projectLeaf(undefined)).toBeNull();
    expect(projectLeaf("/")).toBeNull();
    expect(projectLeaf("")).toBeNull();
  });
});

describe("sharedIsReleasable", () => {
  it("is true when every co-owner is closed", () => {
    expect(
      sharedIsReleasable(
        sharedFile([
          { id: "s1", name: "probe", live: false },
          { id: "s2", name: "older", live: false },
        ]),
      ),
    ).toBe(true);
  });

  it("is false while any co-owner is running — releasing would sever it", () => {
    expect(
      sharedIsReleasable(
        sharedFile([
          { id: "s1", name: "probe", live: false },
          { id: "s2", name: "alpha", live: true },
        ]),
      ),
    ).toBe(false);
  });

  it("is false with no co-owners named and false when unshared", () => {
    expect(sharedIsReleasable(sharedFile(undefined))).toBe(false);
    expect(sharedIsReleasable(sharedFile([]))).toBe(false);
    expect(
      sharedIsReleasable(sharedFile([{ id: "s1", name: "probe", live: false }], false)),
    ).toBe(false);
  });
});

/**
 * The `@` completion over a session's project and the folders it was granted.
 *
 * A query goes to every root; a granted folder is held once, gets its own
 * store, and its rows carry absolute values; answers merge by score; a folder
 * that leaves the session's list stops being asked.
 */

import { describe, expect, test } from "bun:test";

import { Subscribable } from "../subscribable";
import type { FileTreeResultSnapshot, FileTreeStore, ScoredResult } from "../filetree-store";
import {
  SessionFileCompletion,
  type FolderHolds,
  type GrantedFolders,
  type HeldFolder,
} from "../session-file-completion";

/** A FILETREE store answering from a canned table, keyed by query. */
class FakeTree extends Subscribable {
  sent: Array<{ query: string; root: string | undefined }> = [];
  disposed = false;
  private snapshot: FileTreeResultSnapshot = { query: "", results: [], truncated: false };
  constructor(
    private readonly root: string | null,
    private readonly answers: Record<string, ScoredResult[]>,
  ) {
    super();
  }
  sendQuery(query: string, root?: string): void {
    this.sent.push({ query, root });
  }
  /** Land the answer to `query`, as a FILETREE frame would. */
  answer(query: string): void {
    this.snapshot = { query, results: this.answers[query] ?? [], truncated: false };
    this.notify();
  }
  getSnapshot = (): FileTreeResultSnapshot => this.snapshot;
  answeredRoot(): string | null {
    return this.root;
  }
  dispose(): void {
    this.disposed = true;
  }
}

class FakeFolders extends Subscribable implements GrantedFolders {
  private dirs: string[] = [];
  set(dirs: string[]): void {
    this.dirs = dirs;
    this.notify();
  }
  getSnapshot = () => ({ additionalDirectories: this.dirs });
}

class FakeHolds extends Subscribable implements FolderHolds {
  asked: string[] = [];
  private held = new Map<string, HeldFolder>();
  acquire(path: string): void {
    this.asked.push(path);
  }
  grant(path: string): void {
    this.held.set(path, { workspaceKey: path, projectDir: path });
    this.notify();
  }
  get(path: string): HeldFolder | null {
    return this.held.get(path) ?? null;
  }
}

const result = (path: string, score: number): ScoredResult => ({ path, score, matches: [[0, 2]] });

function setup() {
  const project = new FakeTree("/u/src/tug", {
    idx: [result("tugdeck/index.html", 40)],
  });
  const site = new FakeTree("/u/src/tug-site", {
    idx: [result("src/index.astro", 90)],
  });
  const folders = new FakeFolders();
  const holds = new FakeHolds();
  const made: string[] = [];
  const completion = new SessionFileCompletion({
    project: project as unknown as FileTreeStore,
    projectKey: "/u/src/tug",
    folders,
    holds,
    makeStore: (held) => {
      made.push(held.projectDir);
      return { store: site as unknown as FileTreeStore, dispose: () => site.dispose() };
    },
  });
  return { project, site, folders, holds, made, completion, provider: completion.getProvider() };
}

describe("SessionFileCompletion", () => {
  test("with no granted folder, it is the project's completion", () => {
    const { project, provider } = setup();
    expect(provider("idx")).toEqual([]);
    expect(project.sent).toEqual([{ query: "idx", root: "/u/src/tug" }]);
    project.answer("idx");
    expect(provider("idx").map((i) => i.atom.value)).toEqual(["tugdeck/index.html"]);
  });

  test("a granted folder is held once, queried at its root, and merged by score with absolute values", () => {
    const { project, site, folders, holds, made, provider } = setup();
    folders.set(["/u/src/tug-site"]);
    expect(holds.asked).toEqual(["/u/src/tug-site"]);
    expect(made).toEqual([]);
    holds.grant("/u/src/tug-site");
    expect(made).toEqual(["/u/src/tug-site"]);

    provider("idx");
    expect(site.sent).toEqual([{ query: "idx", root: "/u/src/tug-site" }]);
    project.answer("idx");
    site.answer("idx");
    const items = provider("idx");
    expect(items.map((i) => [i.label, i.atom.value])).toEqual([
      ["tug-site/src/index.astro", "/u/src/tug-site/src/index.astro"],
      ["tugdeck/index.html", "tugdeck/index.html"],
    ]);
    // The highlight moves past the folder-name prefix.
    expect(items[0].matches).toEqual([[9, 11]]);
    // Asked once, however often the stores notify.
    holds.notify();
    folders.notify();
    expect(holds.asked).toEqual(["/u/src/tug-site"]);
  });

  test("the project directory is never added as a folder of its own", () => {
    const { folders, holds, made } = setup();
    folders.set(["/u/src/tug"]);
    expect(holds.asked).toEqual([]);
    expect(made).toEqual([]);
  });

  test("a folder that leaves the session's list is let go", () => {
    const { site, folders, holds, project, provider } = setup();
    folders.set(["/u/src/tug-site"]);
    holds.grant("/u/src/tug-site");
    folders.set([]);
    expect(site.disposed).toBe(true);
    provider("idx");
    expect(site.sent).toEqual([]);
    expect(project.sent.length).toBe(1);
  });
});

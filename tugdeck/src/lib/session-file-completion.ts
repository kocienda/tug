/**
 * session-file-completion.ts — the `@` completion over every folder a session
 * may reach: its project directory, and each folder `/add-dir` (or the
 * project's remembered settings) granted it.
 *
 * FILETREE answers one root per query: tugcast routes a query by its `root`
 * to that directory's registered workspace and indexes paths relative to it.
 * The project's workspace exists because the session's spawn registered it;
 * an added folder has none until something asks, so this source takes a
 * browse hold on each one (`acquireWorkspace`, the hold Open Quickly uses,
 * which indexes a folder without adding it to the Changes card) and keeps one
 * {@link FileTreeStore} per folder, each on its own feed filter, so the
 * answers of one root never overwrite another's.
 *
 * A query goes to every root; the answers merge by score, so a match in an
 * added folder ranks beside the project's rather than under all of them. A
 * project file keeps its project-relative value, which is what an `@`
 * mention has always carried. An added folder's file carries its ABSOLUTE
 * path — the only spelling that names it from the session's own directory —
 * and is labelled `<folder name>/<path>`, so the row says where it lives.
 *
 * The folders are the session metadata store's `additionalDirectories`,
 * which the wire reports already canonical ([L29]), so a folder held two
 * ways is one root here. The provider is a stable closure ([L07]) whose
 * `subscribe` fires on any root's answer ([L22]).
 *
 * @module lib/session-file-completion
 */

import { Subscribable } from "./subscribable";
import type { FileTreeStore, ScoredResult } from "./filetree-store";
import type { CompletionItem, CompletionProvider } from "./tug-text-types";

/** The read side of the store that says which folders the session holds. */
export interface GrantedFolders {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { additionalDirectories: readonly string[] };
}

/** A folder tugcast answers FILETREE queries for, as a browse hold reports it. */
export interface HeldFolder {
  readonly workspaceKey: string;
  readonly projectDir: string;
}

/** The browse-hold cache, as `default-workspace-store` exposes it. */
export interface FolderHolds {
  acquire(path: string): void;
  get(path: string): HeldFolder | null;
  subscribe(listener: () => void): () => void;
}

/** One added folder's query store and how to let it go. */
export interface FolderStore {
  readonly store: FileTreeStore;
  dispose(): void;
}

/** The last segment of a path: what an added folder's rows are labelled with. */
function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at === -1 ? trimmed : trimmed.slice(at + 1);
}

interface Root {
  /** The folder's absolute path, or null for the project (whose values stay relative). */
  readonly absolute: string | null;
  readonly store: FileTreeStore;
  /** The query last put on the wire to this root. */
  lastSent: string | null;
}

export class SessionFileCompletion extends Subscribable {
  private readonly added = new Map<string, { folder: FolderStore; root: Root; release: () => void }>();
  private readonly project: Root;
  private readonly releases: Array<() => void> = [];
  /**
   * Folders a hold has been asked for. Asked once: the hold cache retries a
   * failed hold on every ask and notifies when it settles, which would
   * re-enter {@link sync} and ask again — a loop of requests for a folder
   * tugcast cannot hold. A folder that leaves the list is forgotten, so
   * granting it again asks again.
   */
  private readonly asked = new Set<string>();
  private disposed = false;

  constructor(
    private readonly args: {
      /** The project's own store, routed to the card's workspace. */
      project: FileTreeStore;
      /** The project directory's workspace key, so the project is never added twice. */
      projectKey: string;
      folders: GrantedFolders;
      holds: FolderHolds;
      /** Build the query store for one held folder. */
      makeStore: (held: HeldFolder) => FolderStore;
    },
  ) {
    super();
    this.project = { absolute: null, store: args.project, lastSent: null };
    this.releases.push(
      args.project.subscribe(() => this.notify()),
      args.folders.subscribe(() => this.sync()),
      args.holds.subscribe(() => this.sync()),
    );
    this.sync();
  }

  /** Match the per-folder stores to the folders the session holds now. */
  private sync(): void {
    if (this.disposed) return;
    const wanted = new Set<string>();
    for (const dir of this.args.folders.getSnapshot().additionalDirectories) {
      if (dir === "" || dir === this.args.projectKey) continue;
      wanted.add(dir);
      if (this.added.has(dir)) continue;
      if (!this.asked.has(dir)) {
        this.asked.add(dir);
        this.args.holds.acquire(dir);
      }
      const held = this.args.holds.get(dir);
      if (held === null || held.workspaceKey === this.args.projectKey) continue;
      const folder = this.args.makeStore(held);
      const root: Root = { absolute: held.projectDir, store: folder.store, lastSent: null };
      const release = folder.store.subscribe(() => this.notify());
      this.added.set(dir, { folder, root, release });
    }
    for (const [dir, entry] of this.added) {
      if (wanted.has(dir)) continue;
      entry.release();
      entry.folder.dispose();
      this.added.delete(dir);
    }
    for (const dir of this.asked) {
      if (!wanted.has(dir)) this.asked.delete(dir);
    }
  }

  private roots(): Root[] {
    return [this.project, ...Array.from(this.added.values(), (entry) => entry.root)];
  }

  /**
   * The `@` provider. Sends the query to every root whose last query differs,
   * then merges the answers that match it, best score first. Until a root
   * answers the current query its rows are carried over from the last
   * answer, which keeps the popup from flashing empty between keystrokes.
   */
  getProvider(): CompletionProvider {
    let lastValid: CompletionItem[] = [];
    const provider = ((query: string): CompletionItem[] => {
      const scored: Array<{ score: number; item: CompletionItem }> = [];
      let answered = false;
      for (const root of this.roots()) {
        if (root.lastSent !== query) {
          root.lastSent = query;
          root.store.sendQuery(query, root.absolute ?? root.store.answeredRoot() ?? undefined);
        }
        const snapshot = root.store.getSnapshot();
        if (snapshot.query !== query) continue;
        answered = true;
        for (const result of snapshot.results) scored.push({ score: result.score, item: itemFor(root, result) });
      }
      if (answered) {
        scored.sort((a, b) => b.score - a.score);
        lastValid = scored.map((entry) => entry.item);
      }
      return lastValid;
    }) as CompletionProvider;
    provider.subscribe = (listener: () => void) => this.subscribe(listener);
    return provider;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const release of this.releases) release();
    for (const entry of this.added.values()) {
      entry.release();
      entry.folder.dispose();
    }
    this.added.clear();
    this.clearListeners();
  }
}

/** A FILETREE result as a completion row, from the root that answered it. */
function itemFor(root: Root, result: ScoredResult): CompletionItem {
  const type = result.is_dir ? "directory" : "file";
  if (root.absolute === null) {
    return {
      label: result.path,
      atom: { kind: "atom", type, label: result.path, value: result.path },
      matches: result.matches,
    };
  }
  const base = root.absolute.replace(/\/+$/, "");
  const prefix = `${folderName(base)}/`;
  const label = `${prefix}${result.path.replace(/^\/+/, "")}`;
  return {
    label,
    atom: { kind: "atom", type, label, value: `${base}/${result.path.replace(/^\/+/, "")}` },
    matches: result.matches.map(([start, end]) => [start + prefix.length, end + prefix.length]),
  };
}

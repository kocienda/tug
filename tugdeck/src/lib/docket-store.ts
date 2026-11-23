/**
 * Account-global docket store — the DOCKETS feed (0x2A) as app-level external
 * state.
 *
 * Shaped like `ChangesetAllStore`: an app-level singleton holding a
 * `FeedStore` over DOCKETS with no workspace filter, since one frame carries
 * every open project. Attached once per page at boot with
 * {@link attachDocketStore} — in the shell page and in every card's own body
 * page — and read through {@link useDockets}. With no store attached the idle
 * (empty) snapshot answers.
 *
 * The store only reads. Every write is a CONTROL verb (`docket-verbs.ts`);
 * the server's watch sees the store move and the next frame carries it.
 *
 * Laws: [L02] external state enters React through useSyncExternalStore only;
 * [L29] a project is matched on its workspace key, never on a raw path.
 *
 * @module lib/docket-store
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";

import type { TugConnection } from "../connection";
import { FeedId } from "../protocol";
import { FeedStore } from "./feed-store";
import { Subscribable } from "./subscribable";
import {
  isDocketsSnapshot,
  type DocketEntry,
  type DocketsSnapshot,
  type ProjectDockets,
} from "./docket-types";

/** The empty snapshot — no open projects yet. Frozen and shared. */
const IDLE_SNAPSHOT: DocketsSnapshot = Object.freeze({
  projects: [] as ProjectDockets[],
});

export class DocketStore extends Subscribable {
  private _snapshot: DocketsSnapshot = IDLE_SNAPSHOT;
  private readonly _feedStore: FeedStore;
  private readonly _unsubscribeFeed: () => void;
  private _lastPayloadRef: unknown = undefined;

  constructor(connection: TugConnection) {
    super();
    this._feedStore = new FeedStore(connection, [FeedId.DOCKETS]);
    this._unsubscribeFeed = this._feedStore.subscribe(() => this._onFeedUpdate());
    // DOCKETS is a deliver-on-connect snapshot feed, so its retained frame
    // can land in the FeedStore during its construction, before the
    // subscription above existed. The feed is diff-suppressed, so nothing
    // would re-announce it: adopt whatever is already held.
    this._onFeedUpdate();
  }

  private _onFeedUpdate(): void {
    const payload = this._feedStore.getSnapshot().get(FeedId.DOCKETS);
    if (payload === this._lastPayloadRef) return;
    this._lastPayloadRef = payload;
    if (!isDocketsSnapshot(payload)) return;
    this._snapshot = payload;
    this.notify();
  }

  dispose(): void {
    this._unsubscribeFeed();
    this._feedStore.dispose();
    this.clearListeners();
  }

  getSnapshot = (): DocketsSnapshot => this._snapshot;
}

// ---------------------------------------------------------------------------
// Singleton + hook
// ---------------------------------------------------------------------------

let _activeStore: DocketStore | null = null;

export function attachDocketStore(conn: TugConnection): DocketStore {
  if (_activeStore !== null) return _activeStore;
  _activeStore = new DocketStore(conn);
  return _activeStore;
}

export function getDocketStore(): DocketStore | null {
  return _activeStore;
}

/** Test-only: detach the singleton between cases. */
export function _resetDocketStoreForTest(): void {
  _activeStore?.dispose();
  _activeStore = null;
}

/** React hook: every open project's dockets. Idle when no store is attached. */
export function useDockets(): DocketsSnapshot {
  return useSyncExternalStore(
    (listener) => {
      const store = _activeStore;
      if (store === null) return () => {};
      return store.subscribe(listener);
    },
    () => _activeStore?.getSnapshot() ?? IDLE_SNAPSHOT,
    () => IDLE_SNAPSHOT,
  );
}

// ---------------------------------------------------------------------------
// Lookups (pure)
// ---------------------------------------------------------------------------

/** A docket found in a snapshot, with the project that holds it. */
export interface DocketHit {
  project: ProjectDockets;
  docket: DocketEntry;
}

/** The docket a live arc is filed on, and the key of the thread it anchors. */
export interface ArcDocketHit extends DocketHit {
  threadKey: string;
}

/**
 * The docket holding a **live** arc named `name`, in the project whose
 * `workspace_key` is `workspaceKey`, and the key of that arc's thread; null
 * when none holds it. A joined or discarded generation of the same name is a
 * different arc and never answers, and neither does another project's arc.
 * Retired dockets are searched too: the arc is on it whether or not the card
 * shows it.
 */
export function docketForArc(
  snapshot: DocketsSnapshot,
  workspaceKey: string | null,
  name: string,
): ArcDocketHit | null {
  if (workspaceKey === null) return null;
  const project = snapshot.projects.find((p) => p.workspace_key === workspaceKey);
  if (project === undefined) return null;
  for (const docket of project.dockets) {
    const thread = docket.threads.find(
      (t) => t.arc?.name === name && t.arc.fate === "live",
    );
    if (thread !== undefined) return { project, docket, threadKey: thread.key };
  }
  return null;
}

/** The docket with id `id` in any open project, or null. */
export function docketById(snapshot: DocketsSnapshot, id: string): DocketHit | null {
  for (const project of snapshot.projects) {
    const docket = project.dockets.find((d) => d.id === id);
    if (docket !== undefined) return { project, docket };
  }
  return null;
}

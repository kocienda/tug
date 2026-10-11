/**
 * default-workspace-store.ts — the frontend's cache of browse holds on
 * directories that no session card has opened.
 *
 * Open Quickly searches through the FILETREE feed, which routes a query by
 * its `root` to a registered workspace on the tugcast side. A bound session
 * card already has one. With no bound card — an empty deck, or the in-bar
 * directory switcher pointed at a recent project — nothing has registered the
 * directory, so this store asks tugcast for a browse hold
 * (`POST /api/workspace/acquire`) and caches the `{workspaceKey, projectDir}`
 * it answers with.
 *
 * Holds are kept for the app's lifetime rather than per popup-open. Releasing
 * at zero refcount tears the workspace entry down, so an acquire/release pair
 * around each ⇧⌘O would re-walk the directory on every invocation. The
 * bootstrap `--source-tree` workspace already lives process-long; these are
 * the same shape. The one release that does happen is when the default
 * project directory setting changes: the old hold is dropped so its watcher
 * goes away, and the next open acquires the new path.
 *
 * Acquisition is asynchronous and the popup renders immediately, so a caller
 * reads `null` until the round trip lands and re-renders on the store's
 * notification ([L02] via `useSyncExternalStore`).
 *
 * @module lib/default-workspace-store
 */

import { createSubscribable } from "./subscribable";
import { getTugbankClient } from "./tugbank-singleton";
import { makeDirectory } from "./fs-mkdir";
import {
  DEFAULT_PROJECT_PATH_DOMAIN,
  readDefaultProjectPath,
} from "@/settings-api";

/** A directory tugcast has registered and will answer FILETREE queries for. */
export interface AcquiredWorkspace {
  readonly workspaceKey: string;
  readonly projectDir: string;
}

/** What the cache knows about one path. */
type Entry =
  | { readonly state: "pending" }
  | { readonly state: "ready"; readonly workspace: AcquiredWorkspace }
  | { readonly state: "failed" };

const cache = new Map<string, Entry>();
const listeners = createSubscribable();

/**
 * The path whose hold is the *default* one — tracked separately so a change to
 * the setting can release exactly that hold and leave switcher-acquired
 * recents alone.
 */
let heldDefaultPath: string | null = null;

/** Whether the tugbank subscription that watches the setting is installed. */
let watchingSetting = false;

function notify(): void {
  listeners.notify();
}

/** Subscribe to acquisition changes — the `useSyncExternalStore` half. */
export function subscribeWorkspaces(listener: () => void): () => void {
  return listeners.subscribe(listener);
}

/**
 * The acquired workspace for `path`, or null when it has not been acquired,
 * is still in flight, or failed. Reference-stable while the entry is
 * unchanged, so it is safe as a `useSyncExternalStore` snapshot.
 */
export function getWorkspace(path: string): AcquiredWorkspace | null {
  const entry = cache.get(path);
  return entry !== undefined && entry.state === "ready" ? entry.workspace : null;
}

/**
 * Ask tugcast for a browse hold on `path`, at most once per path. A pending
 * or successful acquisition is a no-op; a previously failed one retries, so a
 * directory that was missing when first tried can be reached after the user
 * creates it.
 *
 * `create` makes the directory first — true only for the resolved default,
 * which Tug offers to own. An arbitrary recent project the user picked in the
 * switcher is never conjured into existence.
 */
export function acquireWorkspace(path: string, create = false): void {
  if (path === "") return;
  const existing = cache.get(path);
  if (existing !== undefined && existing.state !== "failed") return;

  cache.set(path, { state: "pending" });
  void (async () => {
    if (create) await makeDirectory(path);
    let workspace: AcquiredWorkspace | null = null;
    try {
      const res = await fetch("/api/workspace/acquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          workspace_key?: unknown;
          project_dir?: unknown;
        };
        if (
          typeof body.workspace_key === "string" &&
          typeof body.project_dir === "string"
        ) {
          workspace = {
            workspaceKey: body.workspace_key,
            projectDir: body.project_dir,
          };
        }
      }
    } catch {
      // Transport failure — the failed entry below lets a later open retry.
    }
    cache.set(
      path,
      workspace === null ? { state: "failed" } : { state: "ready", workspace },
    );
    notify();
  })();
}

/** Drop a hold: tell tugcast, then forget the cache entry. */
function releasePath(path: string): void {
  const entry = cache.get(path);
  cache.delete(path);
  if (entry === undefined || entry.state !== "ready") return;
  void fetch("/api/workspace/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace_key: entry.workspace.workspaceKey }),
  }).catch((err) => {
    console.warn("[default-workspace] release failed:", err);
  });
}

/**
 * Acquire the app-wide default project directory, creating it if needed, and
 * remember that this path is the one the setting points at.
 *
 * Idempotent per path, so callers may invoke it on every popup open. When the
 * setting has changed since the last call, the previous default's hold is
 * released first — otherwise a renamed projects folder would leave a watcher
 * on the old one for the rest of the session.
 */
export function acquireDefaultWorkspace(path: string): void {
  if (path === "") return;
  watchSetting();
  if (heldDefaultPath !== null && heldDefaultPath !== path) {
    releasePath(heldDefaultPath);
  }
  heldDefaultPath = path;
  acquireWorkspace(path, true);
}

/**
 * Watch the default-project-path setting so a change made in Settings ▸
 * General drops the stale hold immediately, rather than at the next Open
 * Quickly. Installed lazily on first use and never removed — the store is a
 * process-long singleton.
 */
function watchSetting(): void {
  if (watchingSetting) return;
  const client = getTugbankClient();
  if (client === null) return;
  watchingSetting = true;
  client.onDomainChanged((domain: string) => {
    if (domain !== DEFAULT_PROJECT_PATH_DOMAIN) return;
    const explicit = readDefaultProjectPath(client);
    if (heldDefaultPath === null || explicit === heldDefaultPath) return;
    releasePath(heldDefaultPath);
    heldDefaultPath = null;
    notify();
  });
}

/**
 * Drop every hold and forget the cache. Test-surface reset only — production
 * holds live as long as the process does.
 */
export function resetWorkspaceHolds(): void {
  for (const path of Array.from(cache.keys())) releasePath(path);
  heldDefaultPath = null;
  notify();
}

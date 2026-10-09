/**
 * host-facts-store — the facts tugcast publishes about the machine it
 * runs on: the network `hostname` and the login shell's name.
 *
 * The browser cannot know the backend's real hostname or `$SHELL`
 * (`window.location.hostname` is only the URL host), so tugcast resolves
 * them and serves them at `GET /api/host` (Spec S01). Host facts are
 * static for a server's lifetime — this store fetches them exactly once
 * and caches the result.
 *
 * The store starts empty and resolves asynchronously; a failed fetch
 * leaves it empty. Consumers treat an empty (`null`) snapshot as "not
 * yet known" and render nothing for the affected route ([D04]).
 *
 * Reads enter React through `useSyncExternalStore` only — [L02].
 *
 * @module lib/host-facts-store
 */

import { useSyncExternalStore } from "@/lib/gesture-scope";


/** The host facts served by `GET /api/host` (Spec S01). */
export interface HostFacts {
  /** The host's network name, e.g. `studio.local`. */
  hostname: string;
  /** The login shell's basename, e.g. `zsh`; empty if `$SHELL` is unset. */
  shell: string;
  /**
   * The full `$SHELL` path, e.g. `/bin/zsh` or `/usr/local/bin/fish`;
   * empty if `$SHELL` is unset. Added alongside `shell` so consumers
   * that want the full path (the Z4B Shell-route indicator badge does,
   * for readability and to keep the badge from looking tiny next to
   * the longer Code face) don't have to reconstruct it.
   */
  shellPath: string;
  /**
   * The backend user's home directory, e.g. `/Users/ken`; empty if it
   * couldn't be resolved. The browser can't know it, so the Dev session
   * picker seeds its Project Path from this when there is no recent project
   * and no Swift-provided `initial-project-path` hint.
   */
  home: string;
  /**
   * Where Claude Code keeps its user-scope state, as tugcast resolved it:
   * `$CLAUDE_CONFIG_DIR`, else `$HOME/.claude`. Empty from an older tugcast
   * that predates the field. The deck formats every Claude Code path from
   * it (`ClaudeHome.at(claudeHome)`) and never builds one from `home`.
   */
  claudeHome: string;
}

/**
 * Parse a `GET /api/host` response body into {@link HostFacts}.
 *
 * Strict on the two contract fields `hostname` and `shell`, lenient on
 * everything else: a non-object body, or a `hostname` / `shell` that is
 * missing or not a string, yields `null` — the store then stays empty
 * per Spec S01. Unknown extra fields are ignored, so a future server
 * that adds fields stays compatible (Risk R01). An empty-string `shell`
 * is valid: that is what the endpoint sends when `$SHELL` is unset.
 *
 * `shellPath` is treated as additive: when the server omits it (older
 * tugcast that predates the field), the parser falls back to the empty
 * string so the snapshot is well-formed. The Shell-route indicator
 * badge falls back to `shell` then to a `shell` placeholder, so a
 * missing `shellPath` only changes the displayed text, never the
 * parsed-vs-null verdict.
 */
export function parseHostFacts(raw: unknown): HostFacts | null {
  if (raw === null || typeof raw !== "object") return null;
  const { hostname, shell, shellPath, home, claudeHome } = raw as Record<string, unknown>;
  if (typeof hostname !== "string" || typeof shell !== "string") return null;
  return {
    hostname,
    shell,
    shellPath: typeof shellPath === "string" ? shellPath : "",
    home: typeof home === "string" ? home : "",
    claudeHome: typeof claudeHome === "string" ? claudeHome : "",
  };
}

/**
 * The subset of `fetch` + `Response` {@link HostFactsStore} needs. Lets
 * a test inject a stub without constructing a real `Response`.
 */
export type HostFactsFetch = (
  url: string,
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** The endpoint host facts are fetched from (Spec S01). */
const HOST_ENDPOINT = "/api/host";

/**
 * Holds the one-shot host-facts fetch result and notifies subscribers
 * when it resolves.
 *
 * `useSyncExternalStore`-compatible: {@link subscribe} and
 * {@link getSnapshot} are stable, pre-bound references, and
 * `getSnapshot` returns a referentially stable value between renders —
 * the snapshot object is assigned exactly once ([L02]).
 */
export class HostFactsStore {
  private snapshot: HostFacts | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly loaded: Promise<void>;

  /**
   * Kicks off the single `GET /api/host` fetch immediately. `fetchImpl`
   * defaults to the global `fetch`; tests inject a stub.
   */
  constructor(fetchImpl: HostFactsFetch = fetch) {
    this.loaded = this.load(fetchImpl);
  }

  /**
   * Resolves once the one-shot fetch has settled — whether it succeeded
   * or failed. After it resolves, {@link getSnapshot} is final.
   */
  ready(): Promise<void> {
    return this.loaded;
  }

  /** Subscribe to resolution. Returns an unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * The resolved host facts, or `null` while unresolved or after a
   * failed fetch. Referentially stable between renders — safe as a
   * `useSyncExternalStore` snapshot.
   */
  getSnapshot = (): HostFacts | null => this.snapshot;

  private async load(fetchImpl: HostFactsFetch): Promise<void> {
    let facts: HostFacts | null = null;
    try {
      const response = await fetchImpl(HOST_ENDPOINT);
      if (response.ok) {
        facts = parseHostFacts(await response.json());
      }
    } catch {
      // Network failure or a non-JSON body. Leave the snapshot empty;
      // consumers treat empty as "not yet known" (Spec S01, [D04]).
    }
    if (facts !== null) {
      this.snapshot = facts;
      for (const listener of [...this.listeners]) listener();
    }
  }
}

/**
 * The process-wide host-facts store. Constructed once; the single
 * `GET /api/host` fetch fires as a side effect of module load.
 */
export const hostFactsStore = new HostFactsStore();

/**
 * Subscribe a component to the host facts. Returns the resolved
 * {@link HostFacts}, or `null` while unresolved / after a failed fetch.
 */
export function useHostFacts(): HostFacts | null {
  return useSyncExternalStore(
    hostFactsStore.subscribe,
    hostFactsStore.getSnapshot,
  );
}

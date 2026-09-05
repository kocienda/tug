/**
 * session-usage-store.ts — per-**segment** usage cache.
 *
 * What one segment cost, as the ledger sums it: turns, tokens, and active
 * time ([`SessionUsage`]). It reaches the deck beside the session row on
 * `resolve_sessions_ok` answers and `session_updated` pushes, and this store
 * is where a surface holding a segment id can read it by that id ([L02]).
 *
 * **The key is the segment, not the line** — the opposite of the name, the
 * callsign and the synopsis, which are the conversation's and are keyed by
 * line ([P12]). Usage is what one segment did: an arc's implement stage and
 * its audit stage are two segments of one line, and the whole point of the
 * figure is that they differ. Keyed by line the two would overwrite each
 * other.
 *
 * Authoritative from pushes, filled by asks: the telemetry write pushes the
 * row it just made, so a live stage's figure moves as its turns commit, and a
 * receipt mounting on a relaunch asks `resolve_sessions` for the ids it parsed
 * and gets the sums back with the rows. A `removed` push forgets the entry —
 * the ledger no longer holds the segment, so neither does this.
 *
 * There is no polling and no verb of its own. A segment with no telemetry has
 * no entry, which is the same state as one nobody has asked about: the reader
 * shows nothing either way, because a session that recorded no turn has
 * nothing to say and a `0` would be saying something false.
 *
 * @module lib/session-usage-store
 */

import { useSyncExternalStore } from "react";

import type { SessionUsage } from "@/protocol";

class SessionUsageStore {
  private usage = new Map<string, SessionUsage>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** A monotonic token that bumps on every change — the whole-store snapshot. */
  getVersion = (): number => this.version;

  /**
   * What `sessionId` cost, or `undefined` when the ledger has said nothing
   * about it — either because nobody has asked, or because the segment
   * recorded no telemetry. One value for both, because they read the same.
   */
  getUsage = (sessionId: string): SessionUsage | undefined =>
    this.usage.get(sessionId.trim());

  /**
   * Record what the ledger said. `undefined` clears the entry, which is what
   * an answer carrying no usage means: a segment that recorded nothing. No-op
   * and no notify when unchanged, so a repeated push does not churn React.
   */
  set(sessionId: string, usage: SessionUsage | undefined): void {
    const id = sessionId.trim();
    if (id.length === 0) return;
    const current = this.usage.get(id);
    if (usage === undefined) {
      if (current === undefined) return;
      this.usage.delete(id);
    } else {
      if (
        current !== undefined &&
        current.turns === usage.turns &&
        current.tokens === usage.tokens &&
        current.activeMs === usage.activeMs
      ) {
        return;
      }
      this.usage.set(id, usage);
    }
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** Drop the entry for a segment the ledger no longer holds. */
  forget(sessionId: string): void {
    this.set(sessionId, undefined);
  }

  /** Drop everything — for a test, and for a wire that came back new. */
  forgetAll(): void {
    if (this.usage.size === 0) return;
    this.usage.clear();
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/** Module-scope singleton — mirrors the other per-session stores' usage shape. */
export const sessionUsageStore = new SessionUsageStore();

/**
 * The React door: what `sessionId` cost, or `undefined` while the ledger has
 * said nothing about it. Read-only — asking is the citation store's job, and a
 * surface that wants an answer asks there and reads here ([L02]).
 */
export function useSessionUsage(sessionId: string): SessionUsage | undefined {
  return useSyncExternalStore(
    sessionUsageStore.subscribe,
    () => sessionUsageStore.getUsage(sessionId),
  );
}

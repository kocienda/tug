/**
 * session-citation-store.ts — does the ledger hold the session this citation
 * names? ([D132])
 *
 * A citation surface — a History commit row, a Overview ref, the Changes card's
 * orphan hint — holds an id and nothing else, and it has one question to answer
 * before it can render: is that session *findable*? The answer decides between
 * the session atom and [P13]'s slashed inert one, and it must be a fact about
 * the reference rather than a fact about this run. Answered from the client's
 * own caches it is neither: `sessionTagStore` knows only the sessions some
 * listing, push, or binding happened to mention, so the same commit's chip would
 * be resolvable or slashed depending on whether the picker had been opened.
 *
 * So the ledger answers, over the `resolve_sessions` CONTROL verb, and this
 * store is the cache in front of it:
 *
 * 1. **Ask once per id, in batches.** A History card mounts a hundred rows in
 *    one frame; they queue on a microtask and go out as one request. An id
 *    already asked or already answered is never re-asked.
 * 2. **Cache both answers.** A hit records the full id and the row's own facts;
 *    a miss records the miss. Caching the negative is the whole reason the
 *    server names its misses — without it every repaint would re-ask for a
 *    session that will never exist here.
 * 3. **Seed the identity stores from the answer.** A resolved row carries the
 *    ledger's name, callsign and description, so this is a fourth seed path
 *    beside the spawn ack, `list_sessions_ok` and the card-binding rows. That is
 *    what makes `resolveSessionIdentity` able to speak for a session no card is
 *    bound to and no listing covered.
 * 4. **Forget on reconnect.** A wire bounce may have crossed a spawn or a trash,
 *    and a cached miss outliving the session it missed is the one wrong answer
 *    this store could hold for a long time.
 *
 * **The short id is expanded server-side.** A citation records eight hex chars;
 * the answer is keyed by what was asked, so `resolve(queried)` hands back the
 * *full* id the atom, the clipboard flavors and the raise gesture all need. The
 * client deliberately does not try prefix-matching its own caches: the ledger
 * can see every session and detect an ambiguous prefix, and a cache cannot do
 * either.
 *
 * **Laws:** [L02] — components read this through {@link useCitedSession}, which
 * subscribes; the ask fires from an effect, never from a render body. [L27] —
 * the reconnect observer's unregister is held and released by `dispose()`.
 *
 * @module lib/session-citation-store
 */

import { useEffect, useSyncExternalStore } from "react";

import { getConnection } from "@/lib/connection-singleton";
import { getConnectionLifecycle } from "@/lib/connection-lifecycle";
import { sessionNameStore } from "@/lib/session-name-store";
import { sessionSynopsisStore } from "@/lib/session-synopsis-store";
import { sessionTagStore } from "@/lib/session-tag-store";
import {
  identityKeyForSession,
  sessionLineStore,
} from "@/lib/session-line-store";
import {
  encodeResolveSessions,
  type ResolveSessionsOk,
  type SessionRow,
} from "@/protocol";

/** What the ledger said about one cited id. */
export type CitedSessionAnswer =
  /** Asked, no answer yet. The chip renders inert rather than guessing. */
  | { status: "pending" }
  /** The ledger holds it. `sessionId` is the FULL id, even if a short one was
   *  asked; the facts are the row's own, for the resolver's context. */
  | {
      status: "found";
      sessionId: string;
      projectDir: string;
      state: SessionRow["state"];
    }
  /** The ledger holds no such session — an unresolvable citation ([P13]). */
  | { status: "unknown" };

/**
 * The answer for an id that is asked-but-unanswered *and* for one nobody has
 * asked about yet. One value for both because they render identically — inert,
 * with no claim about resolvability in either direction — and because a
 * `getSnapshot` that minted a fresh object per call would spin React.
 */
const PENDING: CitedSessionAnswer = Object.freeze({ status: "pending" });
const UNKNOWN: CitedSessionAnswer = Object.freeze({ status: "unknown" });

class SessionCitationStore {
  /** `askedId → answer`, keyed by the spelling the caller passed in. */
  private answers = new Map<string, CitedSessionAnswer>();
  /** Ids queued for the next batch — drained on a microtask. */
  private queued = new Set<string>();
  private flushScheduled = false;
  private readonly listeners = new Set<() => void>();
  private disposers: (() => void)[] = [];
  private reconnectHooked = false;

  /**
   * Attach the reconnect observer on the first ask rather than at construction.
   * This singleton is constructed during static-import evaluation, which runs
   * before `main.tsx`'s module body calls `registerConnectionLifecycle` — a
   * constructor-time lookup would always find null and the hook would silently
   * never attach. By the first `request()` the lifecycle exists in the app; in
   * tests and in the gallery it stays absent, and the hook is skipped rather
   * than required.
   */
  private ensureReconnectHook(): void {
    if (this.reconnectHooked) return;
    // A bounce may have crossed a spawn or a trash, so every cached answer —
    // the misses especially — is suspect. Dropping them re-asks lazily as the
    // surfaces repaint.
    const lifecycle = getConnectionLifecycle();
    if (lifecycle === null) return;
    this.reconnectHooked = true;
    this.disposers.push(
      lifecycle.observeConnectionDidReconnect(() => this.forgetAll()),
    );
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * The cached answer for `citedId`, without asking. `pending` covers both "the
   * ask is in flight" and "nobody has asked", because they render the same:
   * inert, with no claim about resolvability either way.
   */
  getAnswer = (citedId: string): CitedSessionAnswer =>
    this.answers.get(citedId.trim()) ?? PENDING;

  /**
   * Ask the ledger about `citedId` unless it is already asked or answered.
   * Called from an effect ([L02]); safe to call on every render of every chip.
   */
  request(citedId: string): void {
    this.ensureReconnectHook();
    const id = citedId.trim();
    if (id.length === 0) return;
    if (this.answers.has(id) || this.queued.has(id)) return;
    this.answers.set(id, PENDING);
    this.queued.add(id);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // One request per frame's worth of chips rather than one per chip: a
    // hundred-row History card mounts its rows in a single commit.
    queueMicrotask(() => this.flush());
  }

  /**
   * Apply a `resolve_sessions_ok` frame: settle every id it speaks for, and
   * seed the identity stores from the rows it carried.
   */
  applyResolved(response: ResolveSessionsOk): void {
    let changed = false;
    for (const { queried, session } of response.found) {
      // The ledger's own word about this session, on the same three stores the
      // spawn ack and the listings seed — which is what lets the resolver name
      // a session no card is bound to. Filed under the row's **line** ([P12]),
      // so a citation naming a segment the card has long since left still
      // reads the conversation's callsign and name.
      const lineId =
        session.line_id.length > 0
          ? session.line_id
          : identityKeyForSession(session.session_id);
      sessionLineStore.bind(session.session_id, lineId);
      sessionNameStore.seedName(
        lineId,
        session.name_user_set ? session.name : null,
      );
      sessionTagStore.seedTag(lineId, session.tag);
      sessionSynopsisStore.seedSynopsis(lineId, session.synopsis);
      this.answers.set(queried.trim(), {
        status: "found",
        sessionId: session.session_id,
        projectDir: session.project_dir,
        state: session.state,
      });
      this.queued.delete(queried.trim());
      changed = true;
    }
    for (const id of response.unknown) {
      this.answers.set(id.trim(), UNKNOWN);
      this.queued.delete(id.trim());
      changed = true;
    }
    if (changed) this.notify();
  }

  /**
   * Give up on the ids a failed request named, so a later repaint re-asks. A
   * read error is not evidence about the session, so it must not be cached as
   * `unknown` — that would render a resolvable citation as slashed until
   * reconnect.
   */
  applyFailed(ids: readonly string[]): void {
    let changed = false;
    for (const raw of ids) {
      const id = raw.trim();
      if (this.answers.delete(id)) changed = true;
      this.queued.delete(id);
    }
    if (changed) this.notify();
  }

  /**
   * Drop every answer that speaks for `sessionId` — called when a
   * `session_updated` push carries `removed: true`. A trashed session's cached
   * `found` would otherwise keep its chips resolvable (and raisable) for the
   * rest of the run. Dropping rather than settling to `unknown`: the next
   * repaint re-asks, and the ledger's post-trash answer is authoritative.
   * Answers are keyed by the spelling that was asked, so this matches both the
   * resolved full id and any short-id key that prefixes it.
   */
  forgetSession(sessionId: string): void {
    const full = sessionId.trim();
    if (full.length === 0) return;
    let changed = false;
    for (const [asked, answer] of this.answers) {
      const speaks =
        (answer.status === "found" && answer.sessionId === full) ||
        full.startsWith(asked);
      if (!speaks) continue;
      this.answers.delete(asked);
      this.queued.delete(asked);
      changed = true;
    }
    if (changed) this.notify();
  }

  /** Drop every cached answer. Called on reconnect. */
  forgetAll(): void {
    if (this.answers.size === 0 && this.queued.size === 0) return;
    this.answers.clear();
    this.queued.clear();
    this.notify();
  }

  /** Release the lifecycle registration ([L27]). Test/teardown only. */
  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers = [];
    this.reconnectHooked = false;
    this.listeners.clear();
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.queued.size === 0) return;
    const ids = [...this.queued];
    const connection = getConnection();
    if (connection === null) {
      // No transport (a browser-mode run, or the gallery). Nothing is known and
      // nothing is claimed: drop the asks so a later mount with a live wire
      // tries again.
      this.applyFailed(ids);
      return;
    }
    const frame = encodeResolveSessions(ids);
    connection.send(frame.feedId, frame.payload);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** Module-scope singleton — mirrors the other session-keyed stores' shape. */
export const sessionCitationStore = new SessionCitationStore();

/**
 * The React door: ask the ledger about `citedId` and subscribe to the answer.
 *
 * `citedId` is whatever the citation recorded — a full uuid or an 8-char short
 * id. The returned `sessionId` is the full one once the ledger has answered, so
 * a caller can hand it straight to the resolver, the clipboard, or a raise.
 *
 * The ask lives in an effect rather than in the render body, which is the
 * difference between a component that reads state and one that mutates it while
 * rendering ([L02]).
 */
export function useCitedSession(citedId: string): CitedSessionAnswer {
  const answer = useSyncExternalStore(
    sessionCitationStore.subscribe,
    () => sessionCitationStore.getAnswer(citedId),
  );
  useEffect(() => {
    sessionCitationStore.request(citedId);
  }, [citedId]);
  return answer;
}

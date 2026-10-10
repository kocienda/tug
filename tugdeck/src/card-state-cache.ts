/**
 * The per-card state cache ([D01], [D06]) and the close-time save callbacks.
 *
 * Holds every card's state bag for the session — the primary read source a
 * card mounts from — together with the dirty set, the debounced flush that
 * writes dirty bags to tugbank, the save gate a batch load holds, and the
 * registry of per-card save callbacks the teardown paths invoke.
 *
 * Capture is not here: building a bag from a card's components is the
 * `CardStateOrchestrator`'s, driven by the manager, which hands the result to
 * {@link CardStateCache.set} or {@link CardStateCache.flushNow}. The tugbank
 * write is not here either: it arrives as {@link CardStateCacheDeps.putCardState},
 * which carries the test-mode guard.
 *
 * Nothing subscribes to the cache. A card reads its bag once, at mount, through
 * the deck store's `getCardState`; there is no React reader to notify, so the
 * class carries no subscribe surface for one to need.
 */

import type { CardStateBag } from "./layout-tree";
import { deckTrace, type SaveCallbackSource } from "./deck-trace";

/**
 * Debounce delay for flushing dirty per-card state bags (ms). Kept
 * tighter than the layout debounce: with the 250ms dirty-pipeline
 * debounce in `use-card-dirty-state.ts` this bounds the worst-case
 * edit→durable window at ~0.5s — the most a crash or force-quit (no
 * `saveState` RPC, no `beforeunload` in WKWebView) can lose. [L23]
 */
const CARD_STATE_FLUSH_DEBOUNCE_MS = 250;

/**
 * Outcome of one card-state write attempt, reported by
 * `flushDirty` so teardown-class callers can retry the
 * failures and name the survivors instead of assuming success.
 */
export interface CardFlushResult {
  cardId: string;
  ok: boolean;
}

export interface CardFlushOptions {
  keepalive?: boolean;
  sync?: boolean;
  force?: boolean;
}

export interface CardStateCacheDeps {
  /** Write one bag to tugbank; resolves the write's success flag. */
  putCardState(
    cardId: string,
    bag: CardStateBag,
    options?: { keepalive?: boolean; sync?: boolean },
  ): Promise<boolean>;
}

export class CardStateCache {
  private readonly deps: CardStateCacheDeps;

  /** In-memory cache of per-card state bags. Primary read source during a session. */
  private bags: Map<string, CardStateBag>;

  /** Debounce timer for per-card state saves (separate from layout save timer). */
  private saveTimer: number | null = null;

  /** Set of card IDs with unsaved (dirty) state bags. Used for flush-on-destroy. */
  private dirtyCardIds: Set<string> = new Set();

  /**
   * Nesting depth of active card-state-save suspensions. While > 0, the
   * debounced flush ([A9] persistence) defers — a card mid-load holds the
   * gate so the scroll / region-scroll / content churn of its settle does
   * not fire a `fetch` per dirty card on the same thread the load needs.
   * Sync (will-phase / unload) flushes bypass the gate. Released via the
   * disposer `suspendSaves` returns, which flushes once if still dirty.
   */
  private suspendDepth = 0;

  /**
   * Map of registered save callbacks keyed by card ID. Called on
   * visibilitychange (hidden) and beforeunload so each active card can
   * capture its current state before the page is discarded.
   */
  private saveCallbacks: Map<string, (source?: SaveCallbackSource) => void> = new Map();

  constructor(deps: CardStateCacheDeps, initial?: Map<string, CardStateBag>) {
    this.deps = deps;
    this.bags = initial !== undefined ? new Map(initial) : new Map();
  }

  // ---- Bags ----

  get(cardId: string): CardStateBag | undefined {
    return this.bags.get(cardId);
  }

  /** Store a bag, mark it dirty, and arm the debounced flush. */
  set(cardId: string, bag: CardStateBag): void {
    this.bags.set(cardId, bag);
    this.dirtyCardIds.add(cardId);

    // While a batch load holds the save gate, mark dirty but schedule no
    // flush — never a `fetch` mid-load. The accumulated state is persisted a
    // beat after the load when the gate releases (see `suspendSaves`),
    // and any sync unload flush bypasses the gate regardless.
    if (this.suspendDepth > 0) return;

    this.armFlush();
  }

  /**
   * Seed a bag without marking it dirty — a card's opening payload, or a
   * harness seed, which is already what tugbank should hold or is not the
   * deck's to write.
   */
  seed(cardId: string, bag: CardStateBag): void {
    this.bags.set(cardId, bag);
  }

  /** Forget a destroyed card's bag. */
  delete(cardId: string): void {
    this.bags.delete(cardId);
  }

  /**
   * Store `bag` and persist it durably immediately, skipping the debounce
   * window. `keepalive` lets the PUT outlive an immediately-following
   * teardown. A batch load that holds the save gate leaves the bag in the
   * cache and dirty; the post-load debounce persists it. [L23].
   */
  flushNow(cardId: string, bag: CardStateBag): void {
    this.set(cardId, bag);
    this.cancelFlush();
    void this.flushDirty({ keepalive: true });
  }

  /**
   * Suspend debounced card-state saves while a batch load runs, returning a
   * disposer that resumes them. Counted, so overlapping loads compose. A card
   * holds this across its load + settle so persistence never fetches mid-load.
   *
   * On the final release the settled state is persisted, but one beat PAST the
   * load — the disposer schedules the debounced flush rather than fetching
   * synchronously, so the write lands well clear of the load's hot path. The
   * beat is a macrotask timer (the existing save debounce), never a
   * `requestAnimationFrame` ([L05]). A new load starting within that window
   * cancels the pending flush on engage and re-schedules on its own release.
   * Sync unload flushes are never suspended.
   */
  suspendSaves = (): (() => void) => {
    this.suspendDepth += 1;
    // Cancel a flush scheduled just before the gate engaged (a pre-load save,
    // or a prior release's deferred flush) so nothing fires ungated mid-load.
    this.cancelFlush();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.suspendDepth = Math.max(0, this.suspendDepth - 1);
      // Final release with dirty state: persist it a beat past the load via
      // the debounced flush ([L05] — a macrotask timer, never rAF), off the
      // hot path. A real `set` in the meantime just resets the same
      // debounce; the next load's engage cancels it.
      if (this.suspendDepth === 0 && this.dirtyCardIds.size > 0) {
        this.armFlush();
      }
    };
  };

  /**
   * Write all dirty per-card state bags to tugbank, clear the dirty set,
   * and resolve one {@link CardFlushResult} per attempted write.
   *
   * Persists under `dev.tugapp.deck.cardstate/{cardId}`. A card whose write
   * failed is re-marked dirty before the promise resolves, so the next
   * flush — the debounced one, or the termination pipeline's retry — picks
   * it up again. Silently dropping the bag was the loss path this
   * replaces ([L23]).
   */
  flushDirty(options?: CardFlushOptions): Promise<CardFlushResult[]> {
    // Deferred while a batch load holds the save gate — the dirty set is
    // retained and saved on a later ungated trigger. A `sync` flush
    // (will-phase / unload) must always run, so it bypasses; `force` is
    // the async-fetch equivalent for teardown-class callers that await
    // the writes (prepareForReload) — "no fetch mid-load" is moot when
    // the page is about to be torn down.
    if (this.suspendDepth > 0 && options?.sync !== true && options?.force !== true) {
      return Promise.resolve([]);
    }
    const promises: Promise<CardFlushResult>[] = [];
    for (const cardId of this.dirtyCardIds) {
      const bag = this.bags.get(cardId);
      if (bag !== undefined) {
        promises.push(
          this.deps.putCardState(cardId, bag, options).then((ok) => {
            if (!ok) this.dirtyCardIds.add(cardId);
            return { cardId, ok };
          }),
        );
      }
    }
    this.dirtyCardIds.clear();
    return Promise.all(promises);
  }

  /** Write any pending debounced flush now, so a destroyed deck loses nothing. */
  dispose(): void {
    if (this.saveTimer === null) return;
    this.cancelFlush();
    void this.flushDirty();
  }

  private armFlush(): void {
    this.cancelFlush();
    this.saveTimer = window.setTimeout(() => {
      void this.flushDirty();
      this.saveTimer = null;
    }, CARD_STATE_FLUSH_DEBOUNCE_MS);
  }

  private cancelFlush(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  // ---- Save callbacks for close-time state flush ([D01]) ----

  registerSaveCallback(id: string, callback: (source?: SaveCallbackSource) => void): void {
    this.saveCallbacks.set(id, callback);
  }

  unregisterSaveCallback(id: string): void {
    this.saveCallbacks.delete(id);
  }

  /**
   * Invoke the registered save callback for `id`, if any, recording a
   * `save-callback` deck-trace event tagged with the caller-supplied
   * `source`. `source` is optional for backward compatibility with
   * mock stores in the test suite (they implement the interface with
   * the one-arg shape and still type-check); live callers always pass
   * an explicit tag so the trace preserves the triggering path.
   *
   * The tag is also handed to the callback itself, which forwards it
   * down the capture chain: a card can then capture differently for a
   * save it will never get a render after (`"termination"`) than for a
   * steady-state one.
   *
   * See `deck-trace` for the `save-callback` event shape
   * and the recording-sites list for per-source wiring.
   */
  invokeSaveCallback(id: string, source?: SaveCallbackSource): void {
    const tag: SaveCallbackSource = source ?? "manual";
    deckTrace.record({
      kind: "save-callback",
      cardId: id,
      source: tag,
    });
    this.saveCallbacks.get(id)?.(tag);
  }

  /**
   * The ids with a registered save callback, snapshotted, so a caller
   * iterating them can invoke callbacks that unregister other cards without
   * confusing the Map iterator.
   */
  saveCallbackIds(): string[] {
    return Array.from(this.saveCallbacks.keys());
  }
}

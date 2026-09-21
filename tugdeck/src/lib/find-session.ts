/**
 * find-session — the ONE find controller every find surface instantiates.
 *
 * `FindSession` owns the find *semantics* shared by every card: the query,
 * the option toggles, the published count / active ordinal, and the wrap
 * bookkeeping (`wrapped` / `wrapDirection` / `wrapSeq`) that drives the
 * shared {@link FindWrapOverlay}. It implements {@link FindSurface}, so the
 * shared `TugFindCluster` (toggles + RESULTS badge) reads it directly.
 *
 * What *varies* per surface — how a search actually runs — lives behind a
 * {@link FindEngineDelegate}, in the suite's delegate style
 * (lifecycle-delegates.md): one object with optional methods, fired
 * unconditionally by the session; missing methods are no-ops. Two engines
 * exist today:
 *
 *  - the **transcript engine** (`lib/transcript-find-engine.ts`) — the Dev
 *    card's store→index search over a virtualized row list, painted by the
 *    Custom-Highlight painter;
 *  - the **document engine** (the Text card's find bar) — CM6's own search
 *    over one editor document.
 *
 * A future card type joins find by writing an engine delegate, never by
 * re-implementing session semantics: wrap detection, count publication, and
 * the cluster face come from here, identically.
 *
 * Wrap detection is engine-independent: after a navigation the session
 * re-reads the engine's `matchInfo()` and compares active ordinals — a
 * forward step that does not advance the ordinal (or moves it backward)
 * wrapped past the end; the mirror rule holds for backward steps. A
 * one-match set therefore wraps on every step, which is exactly the felt
 * behavior the overlay should indicate.
 *
 * [L02]: external store — `subscribe` / `getSnapshot` are stable pre-bound
 * references and the snapshot object is replaced on every mutation. The
 * session is pure logic (no React, no DOM), unit-testable with a stub
 * delegate.
 *
 * @module lib/find-session
 */

import type { FindOptions } from "./transcript-search";
import type { FindSurface, FindSurfaceSnapshot } from "./find-surface";

/** The default option set for a fresh session (all toggles off). */
export const DEFAULT_FIND_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  grep: false,
};

/** The engine's published match summary, re-read after every operation. */
export interface FindMatchInfo {
  count: number;
  /** Ordinal of the active match, or `null` when none is active. */
  activeOrdinal: number | null;
  /** True when the engine capped its enumeration (the badge renders `N+`). */
  capped: boolean;
}

/**
 * The per-surface variation point. All methods optional; the session fires
 * every moment unconditionally and treats missing methods as no-ops.
 */
export interface FindEngineDelegate {
  /** The session this delegate now serves (assignment-time pairing). */
  didAttach?(session: FindSession): void;
  /** The session released this delegate. */
  didDetach?(session: FindSession): void;
  /**
   * The query or options changed — run/refresh the engine's search and
   * land on the first result (search-as-you-type semantics). An engine
   * that computes asynchronously (a debounce) calls
   * {@link FindSession.refresh} when its results settle.
   */
  searchDidChange?(query: string, options: FindOptions): void;
  /** Advance the active match (the engine owns wrap-around movement). */
  findNext?(): void;
  /** Retreat the active match. */
  findPrevious?(): void;
  /** The engine's current match summary. */
  matchInfo?(): FindMatchInfo;
  /** Tear down the search (leaving find / empty query). */
  clear?(): void;
}

/** Immutable snapshot handed to `useSyncExternalStore` consumers. */
export interface FindSessionState extends FindSurfaceSnapshot {
  /** The live query text. */
  query: string;
  /** Whether the most recent `next`/`previous` wrapped past an end. */
  wrapped: boolean;
  /** `1` = Next crossed the end, `-1` = Previous crossed the start, `0` = no wrap. */
  wrapDirection: 1 | -1 | 0;
  /**
   * Monotonic wrap counter — incremented on every navigation that wraps,
   * never reset, so the wrap indicator fires even for CONSECUTIVE wraps
   * (a rising-edge boolean would miss them).
   */
  wrapSeq: number;
  /**
   * Monotonic counter of user find GESTURES — a query edit, an option
   * toggle, a next/previous step, and the query replay a surface performs
   * when it takes the session over (⌘F onto a standing query).
   *
   * It is what a host reveals on. Identity ("is this a different match than
   * the one I last showed?") cannot answer alone: a query the user extends
   * often keeps the same match alive, and a host that reveals only on a
   * changed identity leaves that match wherever the transcript happens to
   * be — off screen, under a chip reading "1 of N". A gesture always owes
   * the user its match on screen. Nothing else bumps this, so the
   * background re-searches a streaming transcript provokes never move the
   * scroll out from under a reader.
   */
  navSeq: number;
}

/** Session-level hooks — store-layer seams, not user-interaction callbacks. */
export interface FindSessionHooks {
  /**
   * Fired after every option-toggle change with the new set. Both cards
   * pass the tugbank persist (`putFindOptions`) so the deck-wide
   * find-options preference stays one setting across every find surface.
   */
  onOptionsChanged?: (options: FindOptions) => void;
}

export class FindSession implements FindSurface {
  private state: FindSessionState;
  private readonly listeners = new Set<() => void>();
  private engine: FindEngineDelegate | null = null;
  private readonly hooks: FindSessionHooks;

  constructor(
    initialOptions: FindOptions = DEFAULT_FIND_OPTIONS,
    hooks: FindSessionHooks = {},
  ) {
    this.hooks = hooks;
    this.state = {
      query: "",
      options: initialOptions,
      count: 0,
      activeOrdinal: null,
      capped: false,
      hasQuery: false,
      revealFailed: false,
      wrapped: false,
      wrapDirection: 0,
      wrapSeq: 0,
      navSeq: 0,
    };
  }

  // ── Engine pairing ───────────────────────────────────────────────────────

  /**
   * Assign the engine delegate. The session immediately replays its live
   * query into the new engine (a host may attach after the user has
   * already typed — the engine must not miss the standing search).
   */
  setDelegate(engine: FindEngineDelegate | null): void {
    if (this.engine === engine) return;
    this.engine?.didDetach?.(this);
    this.engine = engine;
    engine?.didAttach?.(this);
    if (engine !== null && this.state.query !== "") {
      this.state = {
        ...this.state,
        revealFailed: false,
        navSeq: this.state.navSeq + 1,
      };
      engine.searchDidChange?.(this.state.query, this.state.options);
      this.refresh();
    }
  }

  // ── Store surface ([L02]) ────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): FindSessionState => this.state;

  // ── Mutation ─────────────────────────────────────────────────────────────

  /** Update the query text; the engine re-searches. Clears the wrap flag. */
  setQuery(query: string): void {
    if (query === this.state.query) return;
    this.state = {
      ...this.state,
      query,
      hasQuery: query !== "",
      revealFailed: false,
      navSeq: this.state.navSeq + 1,
    };
    this.engine?.searchDidChange?.(query, this.state.options);
    this.publishInfo(0);
  }

  /** Update the option toggles; the engine re-searches. Clears the wrap flag. */
  setOptions = (options: FindOptions): void => {
    this.state = {
      ...this.state,
      options,
      revealFailed: false,
      navSeq: this.state.navSeq + 1,
    };
    this.engine?.searchDidChange?.(this.state.query, options);
    this.publishInfo(0);
    this.hooks.onOptionsChanged?.(options);
  };

  /** Advance the active match. Wrap detection via ordinal movement. */
  next(): void {
    const prev = this.state.activeOrdinal;
    this.state = {
      ...this.state,
      revealFailed: false,
      navSeq: this.state.navSeq + 1,
    };
    this.engine?.findNext?.();
    const info = this.readInfo();
    const wrapped =
      info.count > 0 &&
      prev !== null &&
      info.activeOrdinal !== null &&
      info.activeOrdinal <= prev;
    this.publishInfo(wrapped ? 1 : 0, info);
  }

  /** Retreat the active match. Wrap detection via ordinal movement. */
  previous(): void {
    const prev = this.state.activeOrdinal;
    this.state = {
      ...this.state,
      revealFailed: false,
      navSeq: this.state.navSeq + 1,
    };
    this.engine?.findPrevious?.();
    const info = this.readInfo();
    const wrapped =
      info.count > 0 &&
      prev !== null &&
      info.activeOrdinal !== null &&
      info.activeOrdinal >= prev;
    this.publishInfo(wrapped ? -1 : 0, info);
  }

  /**
   * Say whether the host's live reveal failed to put the active match on
   * screen ([P09]). The host is the only caller: it knows the outcome, and
   * the session is what the chip reads. A no-op when nothing changed, so a
   * reveal that lands after a reveal that landed publishes nothing.
   */
  setRevealFailed(flag: boolean): void {
    if (this.state.revealFailed === flag) return;
    this.state = { ...this.state, revealFailed: flag };
    this.emit();
  }

  /** Clear query + search (leaving find). */
  clear(): void {
    this.engine?.clear?.();
    this.state = {
      ...this.state,
      query: "",
      hasQuery: false,
      count: 0,
      activeOrdinal: null,
      capped: false,
      revealFailed: false,
      wrapped: false,
      wrapDirection: 0,
    };
    this.emit();
  }

  /**
   * Re-read the engine's match summary and re-publish. The engine calls
   * this when results settle asynchronously (a debounced transcript
   * search, a navigation performed outside the session — e.g. the
   * document editor's own ⌘G handler).
   */
  refresh(): void {
    this.publishInfo(this.state.wrapDirection, this.readInfo(), true);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private readInfo(): FindMatchInfo {
    if (this.state.query === "" || this.engine?.matchInfo === undefined) {
      return { count: 0, activeOrdinal: null, capped: false };
    }
    return this.engine.matchInfo();
  }

  private publishInfo(
    wrapDirection: 1 | -1 | 0,
    info: FindMatchInfo = this.readInfo(),
    preserveWrap = false,
  ): void {
    const wrapped = preserveWrap ? this.state.wrapped : wrapDirection !== 0;
    this.state = {
      ...this.state,
      ...info,
      wrapped,
      wrapDirection: preserveWrap ? this.state.wrapDirection : wrapDirection,
      wrapSeq:
        !preserveWrap && wrapDirection !== 0
          ? this.state.wrapSeq + 1
          : this.state.wrapSeq,
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.error("FindSession listener threw:", err);
      }
    }
  }
}

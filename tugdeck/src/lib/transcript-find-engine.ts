/**
 * transcript-find-engine — the Session card's {@link FindEngineDelegate}: the
 * store→index search over a virtualized transcript.
 *
 * The engine owns what is transcript-specific about find: the segmented
 * search index, the ordered match set, and the active index. The shared
 * {@link FindSession} drives it through the delegate protocol and owns
 * everything engine-independent (query, options, wrap bookkeeping, the
 * cluster face). The transcript HOST (`session-card-transcript`) consumes the
 * engine's own store surface ([L02]) to paint matches via the
 * Custom-Highlight painter and to reveal the active match — painting is the
 * host's affordance, not the engine's semantics.
 *
 * Search-on-type is debounced (100ms) so a large transcript can't cost a
 * frame per keystroke; when the debounce settles the engine publishes and
 * calls `session.refresh()` so the badge follows. The active match is
 * preserved across re-searches by `(row, segment, start)` identity — a
 * windowing re-run or an unrelated edit doesn't jump the user off their
 * match — otherwise the active index clamps to the first match.
 *
 * @module lib/transcript-find-engine
 */

import {
  searchSegments,
  type FindOptions,
  type RowSegment,
  type SegmentedFindMatch,
} from "./transcript-search";
import {
  DEFAULT_FIND_OPTIONS,
  type FindEngineDelegate,
  type FindMatchInfo,
  type FindSession,
} from "./find-session";

/** Debounce for search-on-type over the whole-transcript index. */
const SEARCH_DEBOUNCE_MS = 100;

/** What the transcript host paints from ([L02] snapshot). */
export interface TranscriptFindEngineSnapshot {
  matches: readonly SegmentedFindMatch[];
  activeIndex: number;
  /**
   * The query these matches ARE the answer to — not the query the session
   * currently holds, which the debounce may still be a keystroke behind. A
   * host revealing on a gesture reads this to tell a settled result set from
   * the previous query's, so a fresh keystroke never jumps the transcript to
   * the old query's match on its way to the new one.
   */
  query: string;
  /** The options those matches were searched with, same contract. */
  options: FindOptions;
}

export class TranscriptFindEngine implements FindEngineDelegate {
  private session: FindSession | null = null;
  private index: RowSegment[][] = [];
  private query = "";
  private options: FindOptions = DEFAULT_FIND_OPTIONS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private state: TranscriptFindEngineSnapshot = {
    matches: [],
    activeIndex: -1,
    query: "",
    options: DEFAULT_FIND_OPTIONS,
  };
  private readonly listeners = new Set<() => void>();

  // ── Delegate protocol (driven by the session) ────────────────────────────

  didAttach(session: FindSession): void {
    this.session = session;
  }

  didDetach(): void {
    this.session = null;
  }

  searchDidChange(query: string, options: FindOptions): void {
    this.query = query;
    this.options = options;
    this.scheduleSearch();
  }

  findNext(): void {
    const n = this.state.matches.length;
    if (n === 0) return;
    this.apply(this.state.matches, (this.state.activeIndex + 1) % n);
  }

  findPrevious(): void {
    const n = this.state.matches.length;
    if (n === 0) return;
    this.apply(this.state.matches, (this.state.activeIndex - 1 + n) % n);
  }

  matchInfo(): FindMatchInfo {
    return {
      count: this.state.matches.length,
      activeOrdinal: this.state.activeIndex >= 0 ? this.state.activeIndex : null,
      capped: false,
    };
  }

  clear(): void {
    this.cancelTimer();
    this.query = "";
    this.apply([], -1);
  }

  // ── Host surface ─────────────────────────────────────────────────────────

  /**
   * Replace the search index (the transcript changed / expansion toggled).
   * Re-runs the standing query against the new projection.
   */
  setIndex(index: RowSegment[][]): void {
    this.index = index;
    if (this.query !== "") this.scheduleSearch();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): TranscriptFindEngineSnapshot => this.state;

  dispose(): void {
    this.cancelTimer();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private scheduleSearch(): void {
    this.cancelTimer();
    if (this.query === "") {
      // Empty query clears immediately — nothing to debounce.
      this.apply([], -1);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const matches = searchSegments(this.index, this.query, this.options);
      // Preserve the active match by identity when it survives the
      // re-search; otherwise clamp to the first match.
      let activeIndex: number;
      if (matches.length === 0) {
        activeIndex = -1;
      } else {
        const prev = this.state.matches[this.state.activeIndex];
        const preserved =
          prev !== undefined
            ? matches.findIndex(
                (m) =>
                  m.row === prev.row &&
                  m.segment === prev.segment &&
                  m.start === prev.start,
              )
            : -1;
        activeIndex = preserved >= 0 ? preserved : 0;
      }
      this.apply(matches, activeIndex);
      // The debounce settled after the session's synchronous read — tell
      // it to re-publish the badge from the fresh results.
      this.session?.refresh();
    }, SEARCH_DEBOUNCE_MS);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private apply(
    matches: readonly SegmentedFindMatch[],
    activeIndex: number,
  ): void {
    this.state = {
      matches,
      activeIndex,
      query: this.query,
      options: this.options,
    };
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        console.error("TranscriptFindEngine listener threw:", err);
      }
    }
  }
}

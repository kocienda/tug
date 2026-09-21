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
 * match.
 *
 * Where a search that can't preserve anything LANDS is the anchor's
 * question, not the index's. A transcript is read from the bottom and grows
 * at the bottom, so match zero is almost never the one the reader meant: the
 * host captures an anchor row when find opens (the bottom-most visible row,
 * or the row holding the selection for ⌘E) and a gesture lands on the last
 * match at or above it, wrapping to the last match in the transcript when
 * there is none. Only with no anchor at all does a landing clamp to the
 * first match. Stepping with `findNext` / `findPrevious` moves the anchor to
 * the match it stepped to, so a query the user then edits stays where they
 * are rather than snapping back to where find opened.
 *
 * **When the projection and the DOM disagree, the DOM wins ([P03]).** The
 * painter compares every mounted row's live text against the segments this
 * engine searched, and hands back what it actually found; `healRows`
 * replaces those rows' `dom` segments with the DOM's own text in a row-id
 * keyed OVERLAY and re-searches synchronously. The raw projection is kept
 * exactly as the host handed it in — the overlay's re-application on the
 * next `setIndex` compares against it, so merging in place would destroy
 * the only thing that can tell a stale heal from a live one — and the
 * search runs over a derived effective index instead. `getIndex()` returns
 * that derived index, because the painter's comparison has to be against
 * the text the matches were actually counted from.
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

/** A row the painter found to disagree with its projection. */
export interface RowHeal {
  /** The row's index in the CURRENT index. */
  row: number;
  /** The row's stable identity — what the overlay is keyed by. */
  rowId: string;
  /** Every DOM unit's live text, in order. */
  domTexts: readonly string[];
}

/**
 * The signature an overlay entry is re-applied against: the whole row's
 * projected text, joined. A fresh projection that still produces this
 * string is the same projection the heal corrected, so the heal still
 * applies; anything else and the row has genuinely changed and the heal is
 * dropped rather than held over text it never saw.
 */
function projectionSignature(segments: readonly RowSegment[]): string {
  return segments.map((s) => s.text).join(" ");
}

/**
 * The row as the DOM says it is: one `dom` segment per DOM unit, with the
 * row's `editor` segments kept in their original relative positions — an
 * embedded CodeMirror virtualizes its own DOM, so the walk never saw those
 * and has nothing to say about them. A `key` is carried across only when
 * the unit count is unchanged; with a different count there is no
 * correspondence to carry it along.
 */
function healedSegments(
  segments: readonly RowSegment[],
  domTexts: readonly string[],
): RowSegment[] {
  const domCount = segments.filter((s) => s.kind === "dom").length;
  const sameCount = domCount === domTexts.length;
  const out: RowSegment[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.kind === "editor") {
      out.push(segment);
      continue;
    }
    if (cursor >= domTexts.length) continue;
    const text = domTexts[cursor];
    const key = sameCount ? segment.key : undefined;
    out.push(key === undefined ? { kind: "dom", text } : { kind: "dom", text, key });
    cursor += 1;
  }
  // More DOM units than the projection knew about: the extras land after
  // the last projected one, which is where the walk found them.
  for (; cursor < domTexts.length; cursor++) {
    out.push({ kind: "dom", text: domTexts[cursor] });
  }
  return out;
}

export class TranscriptFindEngine implements FindEngineDelegate {
  private session: FindSession | null = null;
  private index: RowSegment[][] = [];
  /**
   * The index the search actually runs over: {@link index} with every
   * overlaid row substituted. Recomputed whenever either side changes.
   */
  private effectiveIndex: readonly (readonly RowSegment[])[] = [];
  /** Row index → stable row id, for addressing the overlay. */
  private rowIdOf: (row: number) => string = (row) => String(row);
  /** Healed rows, keyed by row id. See {@link healRows}. */
  private readonly overlay = new Map<
    string,
    { projected: string; healed: RowSegment[] }
  >();
  /**
   * The row the reader is at — the landing rule's origin. `null` means the
   * host has not captured one (no transcript mounted, or an empty list), and
   * a landing then clamps to the first match.
   */
  private anchorRow: number | null = null;
  /**
   * Set when a GESTURE provoked the pending search (a query edit, an options
   * toggle) and cleared when that search runs. It is what separates the two
   * landing rules: a gesture is the user asking a new question and lands at
   * the anchor, while a background re-search — a streaming transcript
   * re-projecting, a row expanding — must preserve what the user was looking
   * at and never move them.
   */
  private gesturePending = false;
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
    this.gesturePending = true;
    this.scheduleSearch();
  }

  findNext(): void {
    const n = this.state.matches.length;
    if (n === 0) return;
    this.step((this.state.activeIndex + 1) % n);
  }

  findPrevious(): void {
    const n = this.state.matches.length;
    if (n === 0) return;
    this.step((this.state.activeIndex - 1 + n) % n);
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
   *
   * `getRowId` is the host's own `dataSource.idForIndex` — the same
   * function the painter is handed. The engine needs it because the heal
   * overlay is keyed by row IDENTITY while an index entry is addressed by
   * row NUMBER, and row numbers are not stable: a compaction or a restore
   * re-bases the whole transcript. It is kept for the life of the index.
   */
  setIndex(index: RowSegment[][], getRowId: (row: number) => string): void {
    this.index = index;
    this.rowIdOf = getRowId;
    this.reapplyOverlay();
    if (this.query !== "") this.scheduleSearch();
  }

  /**
   * Take the DOM's word for what these rows say ([P03]) and re-search at
   * once. One call per paint, so a sweep that finds five diverging rows
   * heals once and re-searches once rather than five times.
   *
   * The re-search is a BACKGROUND one under [P05]: it preserves the active
   * match by `(row, segment, start)` identity, falling back to the match in
   * the same row with the nearest start, and only then to the old ordinal
   * clamped. A heal is the machine correcting itself, never the user asking
   * a new question, so it must not move the reader.
   *
   * It is idempotent per `(rowId, projection)`: the healed row's text IS
   * its DOM text, so the comparison that follows the next paint finds them
   * equal and nothing heals again.
   */
  healRows(entries: readonly RowHeal[]): void {
    let changed = false;
    for (const entry of entries) {
      const segments = this.index[entry.row];
      if (segments === undefined) continue;
      this.overlay.set(entry.rowId, {
        projected: projectionSignature(segments),
        healed: healedSegments(segments, entry.domTexts),
      });
      changed = true;
    }
    if (!changed) return;
    this.recomputeEffectiveIndex();
    this.researchNow();
  }

  /**
   * Tell the engine where the reader is. The host calls this as find opens
   * — before the query arrives — so the first search of a session already
   * knows which match to land on.
   */
  setAnchorRow(row: number | null): void {
    this.anchorRow = row;
  }

  /**
   * The index the match set was searched over — the painter's side of the
   * index/DOM comparison ([P03]). It is deliberately the *searched*
   * projection rather than anything derived at read time: a comparison
   * against text nobody counted would answer a question no one asked.
   * With a heal standing, that is the EFFECTIVE index — the raw projection
   * with the healed rows substituted — for exactly the same reason.
   */
  getIndex(): readonly (readonly RowSegment[])[] {
    return this.effectiveIndex;
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
      const gesture = this.gesturePending;
      this.gesturePending = false;
      const matches = searchSegments(
        this.effectiveIndex as RowSegment[][],
        this.query,
        this.options,
      );
      let activeIndex: number;
      if (matches.length === 0) {
        activeIndex = -1;
      } else if (gesture) {
        // The user asked a new question; answer it where they are reading.
        activeIndex = this.landingIndex(matches);
      } else {
        // Background: preserve the active match by identity when it survives
        // the re-search, so a streaming transcript never steals the reader's
        // place. Only when it does not survive is there a landing to choose,
        // and then the anchor chooses it.
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
        activeIndex = preserved >= 0 ? preserved : this.landingIndex(matches);
      }
      this.apply(matches, activeIndex);
      // The debounce settled after the session's synchronous read — tell
      // it to re-publish the badge from the fresh results.
      this.session?.refresh();
    }, SEARCH_DEBOUNCE_MS);
  }

  /**
   * The last match at or above the anchor row — the one a reader scrolled to
   * this spot would call "the one I'm looking at". With no match at or above
   * it, the search wraps to the transcript's LAST match rather than its
   * first: a reader anchored near the top who searches for something that
   * only appears below them is one ⌘G from the first of those, whereas
   * landing on match zero would have sent them nowhere they asked to go.
   */
  private landingIndex(matches: readonly SegmentedFindMatch[]): number {
    const anchor = this.anchorRow;
    if (anchor === null) return 0;
    for (let i = matches.length - 1; i >= 0; i--) {
      if (matches[i].row <= anchor) return i;
    }
    return matches.length - 1;
  }

  /**
   * Step to `next` and move the anchor with it. Stepping IS the reader
   * moving, so the next query edit starts from the match they stepped to.
   */
  private step(next: number): void {
    const match = this.state.matches[next];
    if (match !== undefined) this.anchorRow = match.row;
    this.apply(this.state.matches, next);
  }

  /**
   * Keep the overlay entries whose rows are still here and still say what
   * they said when the heal corrected them; drop the rest. A row whose id
   * has left the data source is gone, and a row whose fresh projection no
   * longer matches the signature has genuinely changed — holding a heal
   * over either would be asserting the DOM said something about text it
   * has never seen.
   */
  private reapplyOverlay(): void {
    if (this.overlay.size > 0) {
      const rowOf = new Map<string, number>();
      for (let row = 0; row < this.index.length; row++) {
        rowOf.set(this.rowIdOf(row), row);
      }
      for (const [rowId, entry] of [...this.overlay]) {
        const row = rowOf.get(rowId);
        const segments = row === undefined ? undefined : this.index[row];
        if (
          segments === undefined ||
          projectionSignature(segments) !== entry.projected
        ) {
          this.overlay.delete(rowId);
        }
      }
    }
    this.recomputeEffectiveIndex();
  }

  /** Rebuild {@link effectiveIndex} from the raw index and the overlay. */
  private recomputeEffectiveIndex(): void {
    if (this.overlay.size === 0) {
      this.effectiveIndex = this.index;
      return;
    }
    const next: RowSegment[][] = this.index.slice();
    for (let row = 0; row < next.length; row++) {
      const entry = this.overlay.get(this.rowIdOf(row));
      if (entry !== undefined) next[row] = entry.healed;
    }
    this.effectiveIndex = next;
  }

  /**
   * Re-search NOW, without the debounce, preserving what the reader was
   * looking at. The heal's caller is inside a paint: a debounce here would
   * leave the painter holding a match set the index no longer agrees with
   * for another 100 ms, which is the window the wrong highlight lives in.
   *
   * Any pending debounced search is deliberately left armed — it belongs
   * to a keystroke the user has already made, and cancelling it would
   * swallow their gesture. For the same reason this re-searches the
   * PUBLISHED query, not the pending one: answering the pending query here
   * would publish it as settled under the background rule, and the host
   * would reveal an unanchored match a moment before the gesture's own
   * search lands the anchored one.
   */
  private researchNow(): void {
    const { query, options } = this.state;
    if (query === "") return;
    const matches = searchSegments(
      this.effectiveIndex as RowSegment[][],
      query,
      options,
    );
    let activeIndex: number;
    if (matches.length === 0) {
      activeIndex = -1;
    } else {
      const prev = this.state.matches[this.state.activeIndex];
      let found = -1;
      if (prev !== undefined) {
        found = matches.findIndex(
          (m) =>
            m.row === prev.row &&
            m.segment === prev.segment &&
            m.start === prev.start,
        );
        if (found < 0) {
          // The heal moved the offsets under the reader's match. The
          // nearest start in the same row is the same place on screen.
          let best = Number.POSITIVE_INFINITY;
          for (let i = 0; i < matches.length; i++) {
            if (matches[i].row !== prev.row) continue;
            const distance = Math.abs(matches[i].start - prev.start);
            if (distance < best) {
              best = distance;
              found = i;
            }
          }
        }
      }
      activeIndex =
        found >= 0
          ? found
          : Math.min(Math.max(this.state.activeIndex, 0), matches.length - 1);
    }
    this.apply(matches, activeIndex, query, options);
    this.session?.refresh();
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
    query: string = this.query,
    options: FindOptions = this.options,
  ): void {
    this.state = {
      matches,
      activeIndex,
      query,
      options,
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

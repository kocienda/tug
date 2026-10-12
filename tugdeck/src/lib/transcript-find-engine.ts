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
 * **Assistant text and thinking are searched by tugcast.** Those units are
 * remote (`RowSegment.remote`): a search sends tugcast one request naming
 * them in order, plus the mounted ones whose texts the painter will need,
 * and merges tugcast's answer with the local search over every other unit
 * in `(row, segment, start)` order. A literal search's matches come back
 * whole; a grep search gets the units' texts and runs the page's own
 * `RegExp` over them, because only the page can compile one. A unit tugcast
 * holds nothing for, and every remote unit of an answer that never came, is
 * projected here instead. The last answer's matches and texts are kept per
 * unit, for the source they answered, so a heal re-searches synchronously
 * without asking again, and a gesture lands when its answer arrives. A
 * remote unit whose text is not held yet is published `pending`, so the
 * painter compares it only once its text has come.
 *
 * @module lib/transcript-find-engine
 */

import type { FindResultFrame } from "@tugproto/rendered";
import { Subscribable } from "./subscribable";
import {
  compileQuery,
  DEFAULT_MATCH_LIMIT,
  searchSegments,
  type FindOptions,
  type RemoteUnit,
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

/** One find question, as the remote side is asked it. */
export interface RemoteFindRequest {
  query: string;
  options: FindOptions;
  limit: number;
  /** The remote units searched, in transcript order. */
  units: string[];
  /** The mounted remote units whose texts the answer should carry. */
  mountedUnits: string[];
}

/** tugcast's find, as the session's store asks it. */
export interface RemoteFind {
  /** The answer, or `null` when none came in time. */
  request(request: RemoteFindRequest): Promise<FindResultFrame | null>;
}

/** A match's span within one unit. */
interface Span {
  start: number;
  end: number;
}

/** What a search asked, as one string: the options and the query. */
function questionKey(query: string, options: FindOptions): string {
  return `${options.caseSensitive ? 1 : 0}${options.wholeWord ? 1 : 0}${options.grep ? 1 : 0}:${query}`;
}

/** The remote unit a segment is, if it is one. */
function remoteOf(segment: RowSegment): RemoteUnit | undefined {
  return segment.kind === "dom" ? segment.remote : undefined;
}

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
  return segments.map((s) => remoteOf(s)?.source ?? s.text).join(" ");
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

export class TranscriptFindEngine extends Subscribable implements FindEngineDelegate {
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
  /** tugcast's find, when the host has one. */
  private remote: RemoteFind | null = null;
  /** The rows the list has mounted, as the host last reported them. */
  private mountedRange: { firstIndex: number; lastIndex: number } | null = null;
  /** Bumped by every request, so an answer to an older one is dropped. */
  private requestSeq = 0;
  /** A gesture whose search is waiting on its answer still owes its landing. */
  private gestureInFlight = false;
  /** Each remote unit's matches, for the source and question they answered. */
  private readonly remoteMatches = new Map<string, { source: string; question: string; spans: Span[] }>();
  /** Each remote unit's rendered text, for the source it was taken from. */
  private readonly remoteTexts = new Map<string, { source: string; text: string }>();
  private state: TranscriptFindEngineSnapshot = {
    matches: [],
    activeIndex: -1,
    query: "",
    options: DEFAULT_FIND_OPTIONS,
  };

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
    this.requestSeq += 1;
    this.gestureInFlight = false;
    this.apply([], -1);
  }

  // ── Host surface ─────────────────────────────────────────────────────────

  /**
   * Search the remote units through tugcast. With none (a test, a host with
   * no session), every remote unit is projected here, as before.
   */
  setRemote(remote: RemoteFind | null): void {
    this.remote = remote;
  }

  /**
   * The rows the list has mounted. A mounted remote unit whose text the
   * engine does not hold is asked for, so the painter can compare it.
   */
  setMountedRange(range: { firstIndex: number; lastIndex: number } | null): void {
    this.mountedRange = range;
    this.requestMountedTexts();
  }

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
      const gesture = this.gesturePending || this.gestureInFlight;
      this.gesturePending = false;
      const query = this.query;
      const options = this.options;
      const units = this.remoteUnitsIn(0, this.effectiveIndex.length - 1);
      const remote = this.remote;
      if (remote === null || units.length === 0 || compileQuery(query, options) === null) {
        this.gestureInFlight = false;
        this.settle(query, options, gesture);
        return;
      }
      // The answer lands the gesture; a newer search that supersedes this one
      // inherits it.
      this.gestureInFlight = gesture;
      const seq = ++this.requestSeq;
      const mounted = this.mountedRemoteUnits();
      void remote
        .request({
          query,
          options,
          limit: DEFAULT_MATCH_LIMIT,
          units: units.map((u) => u.unit),
          mountedUnits: mounted.map((u) => u.unit),
        })
        .then((answer) => {
          if (seq !== this.requestSeq) return;
          this.gestureInFlight = false;
          this.takeAnswer(query, options, answer, [...units, ...mounted]);
          this.recomputeEffectiveIndex();
          this.settle(query, options, gesture);
        });
    }, SEARCH_DEBOUNCE_MS);
  }

  /**
   * Publish the search of `query` over the effective index: a gesture lands
   * at the anchor; a background re-search keeps the reader's match.
   */
  private settle(query: string, options: FindOptions, gesture: boolean): void {
    const matches = this.searchAll(query, options);
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
    this.apply(matches, activeIndex, query, options);
    // The search settled after the session's synchronous read — tell it to
    // re-publish the badge from the fresh results.
    this.session?.refresh();
  }

  /**
   * Every match of `query`: the local search over every unit tugcast does not
   * answer for, merged with the held matches of every remote unit, in
   * `(row, segment, start)` order and capped as one search is. A remote unit
   * with nothing held for this source and question is answered from its
   * text, projected here when the engine holds none.
   */
  private searchAll(query: string, options: FindOptions): SegmentedFindMatch[] {
    const rows = this.effectiveIndex;
    const question = questionKey(query, options);
    const local = searchSegments(
      rows.map((segments) =>
        segments.some((s) => remoteOf(s) !== undefined)
          ? segments.map((s): RowSegment => (remoteOf(s) !== undefined ? { kind: "dom", text: "" } : s))
          : segments,
      ),
      query,
      options,
    );
    const remote: SegmentedFindMatch[] = [];
    let projected = false;
    for (let row = 0; row < rows.length; row++) {
      const segments = rows[row];
      for (let segment = 0; segment < segments.length; segment++) {
        const unit = remoteOf(segments[segment]);
        if (unit === undefined) continue;
        let held = this.remoteMatches.get(unit.unit);
        if (held === undefined || held.source !== unit.source || held.question !== question) {
          const known = this.remoteTexts.get(unit.unit);
          let text: string;
          if (known !== undefined && known.source === unit.source) {
            text = known.text;
          } else {
            text = unit.project();
            this.remoteTexts.set(unit.unit, { source: unit.source, text });
            projected = true;
          }
          const spans = searchSegments([[{ kind: "dom", text }]], query, options).map((m) => ({
            start: m.start,
            end: m.end,
          }));
          held = { source: unit.source, question, spans };
          this.remoteMatches.set(unit.unit, held);
        }
        for (const span of held.spans) {
          remote.push({ row, segment, start: span.start, end: span.end, segmentKind: "dom" });
        }
      }
    }
    if (projected) this.recomputeEffectiveIndex();
    if (remote.length === 0) return local;
    return [...local, ...remote]
      .sort((a, b) => a.row - b.row || a.segment - b.segment || a.start - b.start)
      .slice(0, DEFAULT_MATCH_LIMIT);
  }

  /**
   * Keep what an answer says: texts for the units it carried, and literal
   * matches for the units it searched. A unit it reports missing — and
   * every unit of an answer that never came — keeps nothing, so the next
   * search projects it here.
   */
  private takeAnswer(
    query: string,
    options: FindOptions,
    answer: FindResultFrame | null,
    asked: readonly RemoteUnit[],
  ): void {
    if (answer === null) return;
    const sourceOf = new Map(asked.map((u) => [u.unit, u.source]));
    for (const [unit, text] of Object.entries(answer.texts ?? {})) {
      const source = sourceOf.get(unit);
      if (source !== undefined) this.remoteTexts.set(unit, { source, text });
    }
    if (options.grep || answer.matches === undefined) return;
    const missing = new Set(answer.missing);
    const question = questionKey(query, options);
    const spansOf = new Map<string, Span[]>();
    for (const match of answer.matches) {
      const spans = spansOf.get(match.unit) ?? [];
      spans.push({ start: match.start, end: match.end });
      spansOf.set(match.unit, spans);
    }
    for (const [unit, source] of sourceOf) {
      if (missing.has(unit)) continue;
      this.remoteMatches.set(unit, { source, question, spans: spansOf.get(unit) ?? [] });
    }
  }

  /** The remote units of rows `first` through `last`, in order. */
  private remoteUnitsIn(first: number, last: number): RemoteUnit[] {
    const out: RemoteUnit[] = [];
    const rows = this.effectiveIndex;
    for (let row = Math.max(first, 0); row <= Math.min(last, rows.length - 1); row++) {
      for (const segment of rows[row]) {
        const unit = remoteOf(segment);
        if (unit !== undefined) out.push(unit);
      }
    }
    return out;
  }

  /** The mounted remote units whose text the engine does not hold for their source. */
  private mountedRemoteUnits(): RemoteUnit[] {
    const range = this.mountedRange;
    if (range === null) return [];
    return this.remoteUnitsIn(range.firstIndex, range.lastIndex).filter((u) => {
      const known = this.remoteTexts.get(u.unit);
      return known === undefined || known.source !== u.source;
    });
  }

  /**
   * Ask for the texts of mounted remote units the engine does not hold, so
   * the painter can compare them. Only under a standing query: the painter
   * runs only when there are matches to paint.
   */
  private requestMountedTexts(): void {
    const remote = this.remote;
    const { query, options } = this.state;
    if (remote === null || query === "") return;
    const mounted = this.mountedRemoteUnits();
    if (mounted.length === 0) return;
    void remote
      .request({ query, options, limit: 0, units: [], mountedUnits: mounted.map((u) => u.unit) })
      .then((answer) => {
        this.takeAnswer(query, options, answer, mounted);
        // A unit tugcast holds nothing for is projected here.
        for (const unit of mounted) {
          const known = this.remoteTexts.get(unit.unit);
          if (known !== undefined && known.source === unit.source) continue;
          this.remoteTexts.set(unit.unit, { source: unit.source, text: unit.project() });
        }
        this.recomputeEffectiveIndex();
        this.apply(this.state.matches, this.state.activeIndex, this.state.query, this.state.options);
      });
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
    const next: RowSegment[][] = this.index.slice();
    for (let row = 0; row < next.length; row++) {
      const entry = this.overlay.size === 0 ? undefined : this.overlay.get(this.rowIdOf(row));
      if (entry !== undefined) {
        next[row] = entry.healed;
        continue;
      }
      // A remote unit carries its text once the engine holds it for its
      // source; until then it stays pending, a placeholder the painter skips.
      const segments = next[row];
      if (!segments.some((s) => remoteOf(s) !== undefined)) continue;
      next[row] = segments.map((s) => {
        const unit = remoteOf(s);
        if (unit === undefined) return s;
        const known = this.remoteTexts.get(unit.unit);
        if (known === undefined || known.source !== unit.source) return s;
        return { kind: "dom", text: known.text, remote: unit };
      });
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
    const matches = this.searchAll(query, options);
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
    this.notifyCatching((err) => {
      console.error("TranscriptFindEngine listener threw:", err);
    });
  }
}

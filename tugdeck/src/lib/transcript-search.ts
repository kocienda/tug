/**
 * transcript-search — the pure match engine behind the Session card's Find
 * route.
 *
 * Given an ordered array of per-row plain-text projections (one string per
 * searchable transcript row, built by `transcript-search-index`) plus a query
 * and options, {@link search} returns the ordered, non-overlapping matches. It
 * is free of React and DOM: counting is a pure function of the projected text,
 * so the authoritative match set is independent of what is currently mounted.
 *
 * Three option axes compose (Case sensitive · Entire word · Grep):
 *
 *   - **grep** — the query is a JavaScript `RegExp` source; otherwise it is
 *     matched as a literal (escaped before compilation).
 *   - **wholeWord** — the compiled source is wrapped `\b(?:…)\b` so a match
 *     must fall on word boundaries.
 *   - **caseSensitive** — toggles the `i` flag.
 *
 * An empty query, or an invalid grep source, yields zero matches (never a
 * throw).
 *
 * @module lib/transcript-search
 */

/** The three composable search-option toggles. */
export interface FindOptions {
  /** Match case exactly (drops the `i` flag). */
  caseSensitive: boolean;
  /** Require word boundaries on both sides (`\b…\b`). */
  wholeWord: boolean;
  /** Treat the query as a `RegExp` source rather than a literal. */
  grep: boolean;
}

/** A single non-overlapping match, located in one projected row. */
export interface FindMatch {
  /** Index into the `rows` array passed to {@link search}. */
  row: number;
  /** Inclusive start offset within `rows[row]`. */
  start: number;
  /** Exclusive end offset within `rows[row]`. */
  end: number;
}

/** A safe upper bound on the total matches a single search returns. */
export const DEFAULT_MATCH_LIMIT = 5000;

const REGEXP_META = /[.*+?^${}()|[\]\\]/g;

/** Escape a literal so it matches verbatim when compiled as a `RegExp`. */
function escapeRegExp(literal: string): string {
  return literal.replace(REGEXP_META, "\\$&");
}

/**
 * Compile a query + options into a global `RegExp`, or `null` when the query
 * is empty or (in grep mode) an invalid pattern. Plain queries are escaped to
 * a literal; grep queries are used verbatim. The result always carries the
 * `g` flag so {@link search} can walk every occurrence.
 */
export function compileQuery(query: string, options: FindOptions): RegExp | null {
  if (query === "") return null;
  const body = options.grep ? query : escapeRegExp(query);
  const source = options.wholeWord ? `\\b(?:${body})\\b` : body;
  const flags = options.caseSensitive ? "g" : "gi";
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/**
 * Find every non-overlapping match of `query` across `rows`, in flat-row
 * order and left-to-right within each row. Zero-width matches (e.g. a grep
 * source that can match empty) are skipped rather than counted, and advance
 * the cursor so the walk terminates. Stops once `limit` matches are found.
 */
export function search(
  rows: readonly string[],
  query: string,
  options: FindOptions,
  limit: number = DEFAULT_MATCH_LIMIT,
): FindMatch[] {
  const re = compileQuery(query, options);
  if (re === null) return [];
  const matches: FindMatch[] = [];
  for (let row = 0; row < rows.length; row++) {
    const text = rows[row];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        // A zero-width hit is not a navigable match; step past it so the
        // global exec cannot spin in place.
        re.lastIndex = m.index + 1;
        continue;
      }
      matches.push({ row, start: m.index, end: m.index + m[0].length });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

/**
 * One search unit of a transcript row, in DOM order.
 *
 *  - `dom` — the text of one `data-tugx-findable` container; matches paint
 *    via the Custom-Highlight DOM walk (`transcript-find-highlighter.ts`).
 *  - `editor` — the full document of one embedded CodeMirror editor (e.g. a
 *    Read file body), keyed by its owning `toolUseId`; matches are counted
 *    from this store text and painted/navigated by the editor's own search
 *    (CM6 virtualizes its DOM, so a DOM walk cannot reach it).
 *
 * A `dom` unit carrying `remote` is one tugcast answers for: an assistant
 * text or expanded thinking Message, searched as a query over tugcast's
 * rendered text rather than projected here (`transcript-find-engine.ts`).
 */
export type RowSegment =
  | {
      kind: "dom";
      text: string;
      /**
       * Optional find-target key (`toolUseId` / `exchangeId`) for a container
       * whose INTERNAL fold can hide part of this unit's text (a terminal's
       * first-N-lines preview) — navigation unfolds it on demand through the
       * card's `FindTargetRegistry`.
       */
      key?: string;
      /** The unit tugcast answers for, when it is one. */
      remote?: RemoteUnit;
      /**
       * Set on a remote unit whose text the page does not hold yet: its
       * `text` is a placeholder, so the painter does not compare it against
       * the DOM until the text arrives.
       */
      pending?: true;
    }
  | { kind: "editor"; key: string; text: string };

/** A unit tugcast answers find for. */
export interface RemoteUnit {
  /** The Message's key, which tugcast's find index is keyed by. */
  unit: string;
  /**
   * The Message's markdown source. A text or a match set is held for the
   * source it was taken from, and a heal is checked against it.
   */
  source: string;
  /** The page's own projection of the unit, for one tugcast cannot answer. */
  project: () => string;
}

/** A {@link FindMatch} tagged with the segment that produced it. */
export interface SegmentedFindMatch extends FindMatch {
  /** Index into the row's segment list. */
  segment: number;
  segmentKind: RowSegment["kind"];
  /** The segment's find-target key (always set for `editor` segments). */
  segmentKey?: string;
}

/**
 * Find every non-overlapping match across per-row **segments** — each row is
 * an ordered list of independent search units (one per `data-tugx-findable`
 * container or embedded editor, in DOM order). Each segment is searched
 * independently, so a match can never span two segments — mirroring the
 * painter, which re-searches each marked container separately. Match offsets
 * are relative to the segment that produced them; consumers rely on the flat
 * ORDER (row, then segment, then offset), not on cross-segment offsets.
 * Stops once `limit` matches are found.
 */
export function searchSegments(
  rows: readonly (readonly RowSegment[])[],
  query: string,
  options: FindOptions,
  limit: number = DEFAULT_MATCH_LIMIT,
): SegmentedFindMatch[] {
  const re = compileQuery(query, options);
  if (re === null) return [];
  const matches: SegmentedFindMatch[] = [];
  for (let row = 0; row < rows.length; row++) {
    const segments = rows[row];
    for (let segment = 0; segment < segments.length; segment++) {
      const unit = segments[segment];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(unit.text)) !== null) {
        if (m[0].length === 0) {
          // A zero-width hit is not a navigable match; step past it so the
          // global exec cannot spin in place.
          re.lastIndex = m.index + 1;
          continue;
        }
        matches.push({
          row,
          start: m.index,
          end: m.index + m[0].length,
          segment,
          segmentKind: unit.kind,
          segmentKey: unit.key,
        });
        if (matches.length >= limit) return matches;
      }
    }
  }
  return matches;
}

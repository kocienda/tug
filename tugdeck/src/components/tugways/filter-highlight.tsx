/**
 * filter-highlight — paint a list-filter query's matched spans inside a row.
 *
 * One renderer for every filtered list (the session picker, the `/resume`
 * overlay, the rail cards, the gallery filter card), so a match looks the
 * same wherever it is found. The output is inline fragments — plain strings
 * and `<mark class="tug-filter-mark">` spans — which compose into a
 * `TugListRow`'s `title` / `subtitle` and therefore keep the row's typography,
 * truncation, and selected-state recolor. Nothing here reaches for the
 * `children` escape hatch.
 *
 * Two entry points, for the two shapes text arrives in:
 *  - {@link renderFilterHighlight} for a plain string.
 *  - {@link renderFilterHighlightSpans} for text already cut into styled runs
 *    (a syntax-highlighted commit message body), where the marks must nest
 *    INSIDE the existing tones instead of replacing them.
 *
 * **Pass the string you render.** Ranges come from the `text` argument
 * ({@link filterHighlightRanges}), so a caller that truncates or collapses
 * whitespace for display must pass that *display* string — ranges taken from
 * the raw source field would paint at the wrong offsets.
 *
 * An unfiltered row costs nothing: an empty query (or a string no term
 * matches) returns the bare string, so the row's DOM is byte-identical to its
 * unfiltered self.
 *
 * The paint is `--tugx-find-match-bg` — the one find-paint token family
 * ([L17]), shared with transcript find and the Text card's code view, so a
 * theme tunes "a match" in one place.
 *
 * Laws: [L06] appearance via CSS; [L17] one-hop component-tier alias;
 *       [L20] token sovereignty — the mark paints its own background only.
 *
 * @module components/tugways/filter-highlight
 */

import "./tug-filter-field.css";

import React from "react";

import { filterHighlightRanges } from "@/lib/text-match";

/**
 * Render `text` with the spans matched by `query` wrapped in `<mark>`.
 *
 * Returns the bare string when the query is empty or no term matches `text`.
 */
export function renderFilterHighlight(
  text: string,
  query: string,
): React.ReactNode {
  const ranges = filterHighlightRanges(query, text);
  if (ranges.length === 0) return text;

  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <mark className="tug-filter-mark" key={`${start}-${end}`}>
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

/** One already-styled run of a line — a syntax span, a status tone, anything. */
export interface FilterHighlightSpan {
  text: string;
  /** The run's own class(es). Empty for an unstyled run. */
  className: string;
  /**
   * The run is inline code, and renders as a real `<code>` element rather
   * than a `<span>`. The tone is the same either way — the element is what
   * carries the *meaning*, which the content annotator reads: code is where
   * a bare relative path is a genuine file reference rather than a word that
   * happens to look like one.
   */
  code?: boolean;
}

/**
 * Render a line that is ALREADY cut into styled runs, with the query's matches
 * marked inside them.
 *
 * The plain {@link renderFilterHighlight} cannot serve text that already
 * carries styling — a syntax-highlighted commit message body, say — because it
 * takes one string and owns the whole output. This takes the runs instead and
 * subdivides them: a match that straddles two runs is marked in both halves,
 * each keeping its own tone. `.tug-filter-mark` sets `color: inherit`, so a
 * marked run reads as its own tone under the highlight rather than losing it.
 *
 * `spans` MUST cover `text` exactly, in order — the ranges are offsets into
 * `text` and are walked against the runs' cumulative lengths. An empty query
 * (or a line no term matches) renders the runs untouched, so unfiltered text is
 * byte-identical to its unstyled-by-this-function self.
 */
export function renderFilterHighlightSpans(
  spans: readonly FilterHighlightSpan[],
  text: string,
  query: string,
): React.ReactNode {
  const ranges = filterHighlightRanges(query, text);
  const wrap = (
    span: FilterHighlightSpan,
    key: number,
    children: React.ReactNode,
  ): React.ReactNode => {
    if (span.code === true) {
      return (
        <code key={key} className={span.className === "" ? undefined : span.className}>
          {children}
        </code>
      );
    }
    return span.className === "" ? (
      children
    ) : (
      <span key={key} className={span.className}>
        {children}
      </span>
    );
  };

  if (ranges.length === 0) {
    return <>{spans.map((span, i) => wrap(span, i, span.text))}</>;
  }

  // One forward cursor over the ranges: both the runs and the ranges are in
  // ascending order, so each range is visited once however the runs fall.
  let rangeAt = 0;
  let at = 0;
  const out: React.ReactNode[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const spanStart = at;
    const spanEnd = at + span.text.length;
    at = spanEnd;
    if (span.text.length === 0) continue;

    const pieces: React.ReactNode[] = [];
    let cut = spanStart;
    // Skip ranges that ended before this run began (a run boundary can land
    // mid-range, so a range may already be partly emitted).
    while (rangeAt < ranges.length && ranges[rangeAt]![1] <= spanStart) rangeAt++;
    for (let r = rangeAt; r < ranges.length; r++) {
      const [rangeStart, rangeEnd] = ranges[r]!;
      if (rangeStart >= spanEnd) break;
      const from = Math.max(rangeStart, cut);
      const to = Math.min(rangeEnd, spanEnd);
      if (to <= from) continue;
      if (from > cut) pieces.push(span.text.slice(cut - spanStart, from - spanStart));
      pieces.push(
        <mark className="tug-filter-mark" key={`${from}-${to}`}>
          {span.text.slice(from - spanStart, to - spanStart)}
        </mark>,
      );
      cut = to;
    }
    if (cut < spanEnd) pieces.push(span.text.slice(cut - spanStart));
    out.push(wrap(span, i, pieces.length === 1 ? pieces[0] : pieces));
  }
  return <>{out}</>;
}

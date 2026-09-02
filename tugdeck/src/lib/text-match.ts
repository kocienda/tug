/**
 * `text-match` — shared text-matching utility for client-side
 * filtering surfaces (the picker, the filter gallery card, any
 * future small-list consumer).
 *
 * Centralizes the matching contract so every filter feels the same:
 * one return shape (`MatchResult`), one default case-folding rule
 * (Unicode default, locale-independent), one offset coordinate
 * system (UTF-16 code units, matching the Rust scorer in
 * `tugrust/crates/tugcast/src/feeds/fuzzy_scorer.rs` and JavaScript's
 * native `String.slice()`).
 *
 * ## Why this exists separately from file completion
 *
 * File completion routes through tugcast's full fuzzy scorer
 * (`fuzzy_scorer.rs`) — server-side, fzf-inspired DP, scored
 * matches with boundary/camel/consecutive bonuses. That is the
 * right shape when the candidate set is a project-scale file tree:
 * thousands of paths, tight scoring matters, the wire round-trip is
 * negligible against the IO it replaces.
 *
 * The picker's recents and the gallery filter card sit at the other
 * extreme: ≤ 50 candidates, every keystroke filters, a wire round-
 * trip per keystroke is wasteful. The right shape there is a tiny
 * client-side matcher with the same return shape so cell renderers
 * can paint highlights identically across surfaces. That's this
 * file.
 *
 * The two implementations CAN drift. This file ships two matchers:
 * `caseInsensitiveSubstring` (the original substring filter used by
 * the picker recents and the gallery card) and `scoreMatch` (a small
 * fzf-lite ranked matcher mirroring the Rust scorer's tier/bonus
 * feel, earned by the slash-command popup — which needs the `@`-file
 * popup's quality ordering and highlight ranges over a ≤ 50-item
 * command set, where a per-keystroke wire round-trip is not worth
 * paying).
 *
 * ## Coordinate system
 *
 * `MatchResult.matches` ranges are **UTF-16 code unit offsets**
 * (half-open intervals — `[start, end)`). This matches:
 *  - JavaScript native string indexing (`String.prototype.slice`,
 *    `String.prototype.charAt`, `string[i]`).
 *  - The Rust scorer's offset contract — see
 *    `fuzzy_scorer.rs:14-19`.
 *
 * For ASCII paths (the typical input) UTF-16 offsets equal codepoint
 * indices. For strings containing supplementary-plane characters
 * (emoji, rare CJK extensions), UTF-16 offsets and codepoint indices
 * differ; rendering code that splits the string with `slice()`
 * should still be correct because `slice()` uses the same
 * coordinate.
 *
 * ## Case folding
 *
 * Uses `String.prototype.toLowerCase()` — locale-independent
 * Unicode default case mapping (ASCII A→a, accented Latin É→é). Not
 * `toLocaleLowerCase()` (which depends on the user's locale and
 * would make matching non-deterministic across machines).
 *
 * Edge case: a few characters expand under default case folding
 * (notably ß → ss). When the lowercased forms have different
 * lengths than their originals, the simple `indexOf` we use here
 * computes the match range in the *lowercased* coordinate, which
 * may not align byte-for-byte with the original string. We don't
 * compensate — this is a documented limitation — because the
 * picker's recents and the gallery card are ASCII paths. A future
 * enhancement (a per-char fold-aware walker) lands when a consumer
 * has Unicode-expansion-bearing data.
 *
 * ## List filtering
 *
 * {@link filterMatchScore} and {@link filterHighlightRanges} are the
 * entry points for the `TugFilterField` list-filter surfaces (the
 * session picker, the `/resume` overlay, the rail cards). They sit
 * on top of `scoreMatch`, adding two things a long list needs that a
 * ≤50-item popup does not: a compactness rule that rejects a match too
 * scattered to mean anything, and a per-row score the list orders by
 * so the strongest matches lead. With no query every row scores the
 * same, so the list keeps its native order.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of a successful match.
 *
 * `matches` is a list of half-open ranges `[start, end)` in UTF-16
 * code unit offsets identifying the matched portions of the target.
 * Cell renderers can paint highlights by walking the ranges and
 * splitting the target string at the boundaries.
 *
 * `score` is optional — only present when the matcher provides a
 * ranking signal. The substring matcher does not return a score
 * (every match is a single contiguous span; ranking among matches
 * uses position only — leftmost first, but the matcher itself
 * surfaces match-or-no-match, not "how good"). A future fuzzy
 * matcher will populate `score`.
 */
export interface MatchResult {
  readonly score?: number;
  readonly matches: ReadonlyArray<readonly [start: number, end: number]>;
}

// ---------------------------------------------------------------------------
// Case-insensitive substring
// ---------------------------------------------------------------------------

/**
 * Case-insensitive substring match.
 *
 * Returns a `MatchResult` with a single range covering the matched
 * span if `target` (case-insensitively) contains `query`, or `null`
 * if it does not.
 *
 *  - Empty `query` matches everything with `matches: []`. This
 *    represents "no filter active" — cell renderers see no ranges
 *    and paint no highlights.
 *  - Empty `target` with non-empty `query` returns `null`.
 *  - Multiple occurrences of `query` in `target` produce a single
 *    range at the LEFTMOST occurrence (the first `indexOf` hit).
 *    Highlighting only the first occurrence keeps the visual signal
 *    deterministic — the alternative (every occurrence) is busy and
 *    rarely useful for path-shaped data.
 *
 * The match offsets are UTF-16 code unit indices into the ORIGINAL
 * `target` (not the lowercased intermediate). For ASCII strings the
 * mapping is exact; for strings whose case-folded form has a
 * different length than the original, see the module docstring's
 * note on the `ß → ss` edge case.
 *
 * @example
 * ```ts
 * caseInsensitiveSubstring("tug", "/Users/Ken/projects/tugtool")
 * // → { matches: [[20, 23]] }
 *
 * caseInsensitiveSubstring("TUGTOOL", "/Users/Ken/projects/tugtool")
 * // → { matches: [[20, 27]] }
 *
 * caseInsensitiveSubstring("nope", "/Users/Ken/projects/tugtool")
 * // → null
 *
 * caseInsensitiveSubstring("", "anything")
 * // → { matches: [] }
 * ```
 */
export function caseInsensitiveSubstring(
  query: string,
  target: string,
): MatchResult | null {
  if (query.length === 0) {
    return { matches: [] };
  }
  if (target.length === 0) {
    return null;
  }

  const haystack = target.toLowerCase();
  const needle = query.toLowerCase();
  const idx = haystack.indexOf(needle);
  if (idx < 0) return null;

  // Map the lowercased-coordinate match back to the original coordinate.
  // For ASCII (the dominant case) and any case-folding that preserves
  // string length per character, `idx` is also the original offset and
  // `query.length` is the matched span. The module docstring's edge-
  // case note covers the rare expansion-bearing strings where this
  // approximation breaks; we intentionally don't pay for a per-char
  // walk to handle data the picker / gallery card never see.
  return { matches: [[idx, idx + query.length]] };
}

// ---------------------------------------------------------------------------
// Ranked match (fzf-lite) — used by slash-command completion
// ---------------------------------------------------------------------------

/**
 * Scoring tiers. Each tier is a *class* of match, ranked strictly above the
 * next: a match in a higher tier always outscores any match in a lower tier,
 * regardless of bonuses. The gap between adjacent tiers ({@link TIER_GAP}) is
 * the hard ceiling on the bonus sum — {@link clampBonus} enforces it — so two
 * candidates can only swap order *within* a tier, never across one.
 */
const EXACT = 10_000;
const PREFIX = 8_000;
const WORD_PREFIX = 6_000;
const SUBSTRING = 4_000;
const SUBSEQUENCE = 2_000;
/** Adjacent-tier spacing; the per-tier bonus is clamped strictly below this. */
const TIER_GAP = 2_000;

/**
 * Within-tier bonuses. All are additive and the total is clamped to
 * `TIER_GAP - 1`, so they tune ordering among same-tier matches without ever
 * promoting a match into the tier above.
 *
 * - `MATCH_RATIO`: favors shorter targets / fuller coverage — `permissions`
 *   over `fewer-permission-prompts` when both prefix-match. The dominant
 *   signal, which is why it's the largest.
 * - `POSITION`: favors a match nearer the start of the target.
 * - `BOUNDARY` / `CONSECUTIVE`: subsequence-only — reward chars landing on
 *   word boundaries and contiguous runs (fzf-feel), so `pm` lights up the two
 *   word starts of `permissions` rather than scattered letters.
 */
const MATCH_RATIO_BONUS = 500;
const POSITION_BONUS = 200;
const BOUNDARY_BONUS = 50;
const CONSECUTIVE_BONUS = 20;

/** Separators that begin a new word (the char *after* one is a boundary). */
const WORD_SEPARATORS = new Set(["-", "_", "/", ".", " "]);

const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase();
const isLower = (c: string): boolean => c !== c.toUpperCase() && c === c.toLowerCase();
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** Clamp the within-tier bonus so it can never cross into the tier above. */
const clampBonus = (bonus: number): number => Math.min(Math.max(0, bonus), TIER_GAP - 1);

/**
 * Mark each index of `target` that starts a word: index 0, the char after a
 * separator, a camelCase hump (`aB`), or a digit run start (`a1`). Computed on
 * the ORIGINAL (un-folded) target so camelCase survives — case folding would
 * erase the `aB` signal.
 */
function wordBoundaries(target: string): boolean[] {
  const flags = new Array<boolean>(target.length).fill(false);
  for (let i = 0; i < target.length; i++) {
    if (i === 0) {
      flags[i] = true;
      continue;
    }
    const prev = target[i - 1]!;
    const cur = target[i]!;
    if (WORD_SEPARATORS.has(prev)) flags[i] = true;
    else if (isLower(prev) && isUpper(cur)) flags[i] = true;
    else if (!isDigit(prev) && isDigit(cur)) flags[i] = true;
  }
  return flags;
}

/**
 * Greedy fzf-style subsequence match: are all of `q`'s chars present in `t`,
 * left to right? Returns merged contiguous highlight ranges plus a score that
 * rewards boundary hits and consecutive runs, or `null` if `q` is not a
 * subsequence of `t`. `q`/`t` are pre-folded; `target` is the original (for
 * boundary detection and range coordinates, which coincide for ASCII).
 */
function subsequenceMatch(
  q: string,
  t: string,
  target: string,
  boundaries: boolean[],
): MatchResult | null {
  const idxs: number[] = [];
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      idxs.push(i);
      qi++;
    }
  }
  if (qi < q.length) return null;

  let boundaryHits = 0;
  let consecutive = 0;
  for (let k = 0; k < idxs.length; k++) {
    if (boundaries[idxs[k]!]) boundaryHits++;
    if (k > 0 && idxs[k]! === idxs[k - 1]! + 1) consecutive++;
  }
  const bonus =
    Math.round((MATCH_RATIO_BONUS * q.length) / target.length) +
    boundaryHits * BOUNDARY_BONUS +
    consecutive * CONSECUTIVE_BONUS +
    Math.max(0, POSITION_BONUS - idxs[0]!);

  // Merge adjacent indices into contiguous [start, end) ranges.
  const matches: Array<readonly [number, number]> = [];
  let start = idxs[0]!;
  let prev = idxs[0]!;
  for (let k = 1; k < idxs.length; k++) {
    if (idxs[k]! === prev + 1) {
      prev = idxs[k]!;
      continue;
    }
    matches.push([start, prev + 1]);
    start = idxs[k]!;
    prev = idxs[k]!;
  }
  matches.push([start, prev + 1]);
  return { score: SUBSEQUENCE + clampBonus(bonus), matches };
}

/**
 * Ranked match used by the slash-command popup so it feels identical to the
 * `@`-file popup: candidates order by match *quality*, not the alphabet, and
 * the returned `matches` ranges drive the same highlight rendering.
 *
 * Returns a `MatchResult` with a `score` (higher = better) and highlight
 * ranges, or `null` when `query` does not match `target` at all. Matching is
 * tiered, highest-wins:
 *
 *  1. **Exact** — folded equal (`permissions` for `permissions`).
 *  2. **Prefix** — target starts with the query (`permi` → `permissions`).
 *  3. **Word-boundary prefix** — query matches at a word start inside the
 *     target (`permi` → fewer-**permi**ssion-prompts), earliest boundary wins.
 *  4. **Substring** — query appears mid-word (`ermi` → p**ermi**ssions).
 *  5. **Subsequence** — query chars appear in order (`pm` → **p**er**m**issions).
 *
 * Within a tier, shorter / fuller / earlier matches rank higher (see the bonus
 * constants). Empty query returns `{ matches: [] }` with no `score`, i.e. "no
 * filter": every candidate passes and ranking falls back to the caller's
 * tiebreak (alphabetical for the command popup). Empty target with a non-empty
 * query returns `null`.
 *
 * Coordinate system and case folding match {@link caseInsensitiveSubstring} —
 * see the module docstring.
 */
/**
 * Command-aware ranked match: score `query` against a slash-command `name`,
 * trying both the full name AND its **leaf** (the part after the last `:`) and
 * keeping the better result, with highlight ranges remapped into full-name
 * coordinates.
 *
 * Plugin commands are namespaced `<plugin>:<leaf>` (`tugplug:commit`). Scoring
 * only the full name buries them: `:` is not a word separator, so a query like
 * `com` is a mere SUBSTRING hit on `tugplug:commit` yet a PREFIX hit on the
 * built-in `compact` — the plugin command the user actually wants ranks below.
 * Scoring the leaf `commit` makes `com` a PREFIX hit there too; because the
 * leaf is shorter than `compact`, its match-ratio bonus is higher, so it ranks
 * at or above the built-in — matching the user's intent that `/com` finds
 * `commit` first. Bare names (no `:`) score exactly as {@link scoreMatch}.
 *
 * On a score tie the leaf result wins (it matched the user-facing command name
 * without the plugin prefix). Returns `null` only when neither the full name
 * nor the leaf matches.
 */
export function scoreCommandMatch(
  query: string,
  name: string,
): MatchResult | null {
  const full = scoreMatch(query, name);
  const colon = name.lastIndexOf(":");
  if (colon < 0) return full;
  const leaf = scoreMatch(query, name.slice(colon + 1));
  if (leaf === null) return full;
  const offset = colon + 1;
  const remapped: MatchResult = {
    score: leaf.score,
    matches: leaf.matches.map(
      ([s, e]) => [s + offset, e + offset] as readonly [number, number],
    ),
  };
  if (full === null) return remapped;
  return (remapped.score ?? 0) >= (full.score ?? 0) ? remapped : full;
}

export function scoreMatch(query: string, target: string): MatchResult | null {
  if (query.length === 0) return { matches: [] };
  if (target.length === 0) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const qlen = q.length;
  const ratioBonus = Math.round((MATCH_RATIO_BONUS * qlen) / target.length);

  if (t === q) {
    return { score: EXACT + clampBonus(ratioBonus), matches: [[0, target.length]] };
  }

  if (t.startsWith(q)) {
    return { score: PREFIX + clampBonus(ratioBonus), matches: [[0, qlen]] };
  }

  const boundaries = wordBoundaries(target);

  // Earliest word boundary at which the whole query matches.
  for (let i = 1; i < target.length; i++) {
    if (!boundaries[i]) continue;
    if (t.startsWith(q, i)) {
      const bonus = ratioBonus + Math.max(0, POSITION_BONUS - i);
      return { score: WORD_PREFIX + clampBonus(bonus), matches: [[i, i + qlen]] };
    }
  }

  const idx = t.indexOf(q);
  if (idx >= 0) {
    const bonus = ratioBonus + Math.max(0, POSITION_BONUS - idx);
    return { score: SUBSTRING + clampBonus(bonus), matches: [[idx, idx + qlen]] };
  }

  return subsequenceMatch(q, t, target, boundaries);
}

// ---------------------------------------------------------------------------
// List filtering — membership + highlight ranges
// ---------------------------------------------------------------------------

/** Split a filter query into its terms; an all-whitespace query has none. */
function filterTerms(query: string): string[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/);
}

/**
 * Sort ranges by start and coalesce every overlapping or adjacent pair, so a
 * caller can walk the result once and never paint two abutting `<mark>`s.
 */
function mergeRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<readonly [number, number]> {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<readonly [number, number]> = [];
  let [start, end] = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    if (s <= end) {
      if (e > end) end = e;
      continue;
    }
    out.push([start, end]);
    start = s;
    end = e;
  }
  out.push([start, end]);
  return out;
}

/**
 * How far a subsequence match may spread before it stops meaning anything.
 *
 * `scoreMatch`'s bottom tier accepts any in-order character run, which is the
 * right answer for a ≤50-item command popup but noise over a list of long
 * strings: `scarp` "matches" a hundred-character prompt through five scattered
 * letters, so a query that should trim 900 session rows to a handful trims
 * nothing. A qualifying match must be COMPACT — the span from its first matched
 * character to its last is at most this multiple of the characters actually
 * matched.
 *
 * At 3 the useful acronym-ish matches survive (`sesldg` spans 12 over 6 matched
 * characters of `session-ledger-store`; `pm` spans 4 over 2 of `permissions`)
 * while the scattered ones do not (`scarp` spans 25 over 5). Contiguous matches
 * — exact, prefix, word-prefix, substring — have span equal to their length, so
 * they always qualify and this rule never touches them.
 */
const MAX_SUBSEQUENCE_SPREAD = 3;

/**
 * Whether a match is compact enough to mean something (see
 * {@link MAX_SUBSEQUENCE_SPREAD}).
 */
function isCompactMatch(result: MatchResult): boolean {
  const ranges = result.matches;
  if (ranges.length <= 1) return true;
  const span = ranges[ranges.length - 1]![1] - ranges[0]![0];
  let matched = 0;
  for (const [start, end] of ranges) matched += end - start;
  return span <= matched * MAX_SUBSEQUENCE_SPREAD;
}

/**
 * Score `term` against `text` for list filtering, or `null` when it does not
 * qualify. Thin wrapper over {@link scoreMatch} that additionally rejects a
 * match too scattered to be meaningful.
 */
function filterTermScore(term: string, text: string): number | null {
  const result = scoreMatch(term, text);
  if (result === null || !isCompactMatch(result)) return null;
  return result.score ?? 0;
}

/**
 * A row's match quality for `query`, or `null` when the row does not pass.
 *
 * EVERY whitespace-separated term must qualify against at least ONE of
 * `fields` — multi-term AND across the union of fields is the trimming
 * semantic the filter fields want, so `tug ledger` keeps the rows that name
 * both, wherever each term happens to live. The row's score is the sum of its
 * terms' best field scores, which a list sorts by so the strongest matches
 * lead. Null/undefined/empty fields are skipped.
 *
 * An empty or all-whitespace query returns `0` — every row passes, all tied, so
 * the list keeps its native order.
 *
 * @example
 * ```ts
 * filterMatchScore("", ["anything"])                     // → 0 (no filter)
 * filterMatchScore("sesldg", ["session-ledger-store"])   // → a subsequence score
 * filterMatchScore("tug ledger", ["tugtool", "ledger"])  // → the summed score
 * filterMatchScore("tug ledger", ["tugtool"])            // → null
 * ```
 */
export function filterMatchScore(
  query: string,
  fields: readonly (string | null | undefined)[],
): number | null {
  const terms = filterTerms(query);
  if (terms.length === 0) return 0;
  let total = 0;
  for (const term of terms) {
    let best: number | null = null;
    for (const field of fields) {
      if (field === null || field === undefined || field.length === 0) continue;
      const score = filterTermScore(term, field);
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}

/**
 * Whether a row passes a list filter — {@link filterMatchScore} without the
 * score, for a consumer that only needs membership.
 */
export function filterQueryMatch(
  query: string,
  fields: readonly (string | null | undefined)[],
): boolean {
  return filterMatchScore(query, fields) !== null;
}

/**
 * Narrow `items` to the ones matching `query`, best match first — the one
 * projection every filtered list runs, so they all trim and rank alike.
 *
 * `fieldsOf` supplies the strings a row is matched on; pass the strings the row
 * DISPLAYS wherever they differ from the source, so what the user reads is what
 * the filter judged. An empty query returns the input untouched (same array
 * reference), so an unfiltered list keeps its native order exactly — the
 * drag-arranged and persisted orders are undisturbed until the user types.
 *
 * The sort is stable: rows of equal quality stay in their native order, so
 * ranking only ever lifts a better match above a worse one.
 */
export function filterAndRank<T>(
  items: readonly T[],
  query: string,
  fieldsOf: (item: T) => readonly (string | null | undefined)[],
): readonly T[] {
  if (filterTerms(query).length === 0) return items;
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const score = filterMatchScore(query, fieldsOf(item));
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}

/**
 * The merged highlight ranges `query` paints over `text` — the union of every
 * QUALIFYING term's ranges (same rule {@link filterMatchScore} keeps rows by,
 * so a row never paints marks from a match too scattered to have kept it),
 * sorted ascending with overlapping and adjacent ranges coalesced.
 *
 * Empty when the query is empty or no term matches this particular string. A
 * row that passed on some *other* field legitimately highlights nothing here.
 *
 * Ranges are UTF-16 offsets into `text`, so callers MUST pass the exact string
 * they render — a truncated or whitespace-collapsed display string, never the
 * raw source field.
 */
export function filterHighlightRanges(
  query: string,
  text: string,
): ReadonlyArray<readonly [number, number]> {
  const terms = filterTerms(query);
  if (terms.length === 0 || text.length === 0) return [];
  const collected: Array<readonly [number, number]> = [];
  for (const term of terms) {
    const result = scoreMatch(term, text);
    if (result === null || !isCompactMatch(result)) continue;
    for (const range of result.matches) collected.push(range);
  }
  return mergeRanges(collected);
}

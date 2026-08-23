// Two-layer fuzzy scorer for file path matching.
//
// Layer 1: character-level DP scorer (fuzzy_score)
// Layer 2: path-aware structural wrapper (score_file_path)
//
// Operates on Unicode characters (not bytes). Match ranges are UTF-16 code
// unit offsets for JavaScript String.slice() compatibility.
//
// Scoring constants adapted from fzf (see THIRD_PARTY_NOTICES.md).

/// A scored match with highlight ranges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoredMatch {
    pub score: i32,
    /// UTF-16 code unit offset ranges `(start, end)` for matched characters.
    /// Each range is a half-open interval. These are UTF-16 offsets (not byte
    /// offsets or codepoint indices) so JavaScript `String.slice()` works
    /// correctly for all Unicode including emoji and supplementary CJK.
    pub matches: Vec<(usize, usize)>,
}

// ---------------------------------------------------------------------------
// Scoring constants (fzf-inspired defaults)
// ---------------------------------------------------------------------------

const SCORE_MATCH: i32 = 16;
const SCORE_CONSECUTIVE: i32 = 8;
const SCORE_BOUNDARY: i32 = 8;
const SCORE_CAMEL: i32 = 7;
// Strictly above SCORE_BOUNDARY: the start of the string is the strongest
// boundary there is. At parity, `CLAUDE` scored `.claude/` (dot-boundary
// start) and `CLAUDE.md` (string start) into an exact tie, and the
// shorter-path tiebreak put the dotdir first.
const SCORE_FIRST_CHAR: i32 = 16;
const SCORE_CASE_EXACT: i32 = 1;
const PENALTY_GAP_FIRST: i32 = -3;
const PENALTY_GAP_EXTENSION: i32 = -1;

/// Large bonus so any basename match outranks any directory-only match.
const BASENAME_TIER_BONUS: i32 = 1 << 17; // 131072

// ---------------------------------------------------------------------------
// Unicode helpers
// ---------------------------------------------------------------------------

/// Single-char Unicode case fold. Handles ASCII (A→a), accented Latin (É→é),
/// and degrades gracefully for rare multi-char expansions (takes first char).
fn fold_case(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Compute cumulative UTF-16 code unit offsets for a char slice.
/// `result[i]` is the UTF-16 offset where the i-th character begins.
fn utf16_offsets(chars: &[char]) -> Vec<usize> {
    let mut offsets = Vec::with_capacity(chars.len() + 1);
    let mut pos: usize = 0;
    for &c in chars {
        offsets.push(pos);
        pos += c.len_utf16();
    }
    offsets.push(pos); // one past the end
    offsets
}

// ---------------------------------------------------------------------------
// Pre-filter
// ---------------------------------------------------------------------------

/// O(n) subsequence check. Returns `true` if every character in `query`
/// appears in `candidate` in order (case-insensitive via Unicode fold).
pub fn contains_chars(query: &str, candidate: &str) -> bool {
    let mut qi = query.chars().map(fold_case);
    let mut current = match qi.next() {
        Some(c) => c,
        None => return true, // empty query matches everything
    };
    for cc in candidate.chars().map(fold_case) {
        if cc == current {
            current = match qi.next() {
                Some(c) => c,
                None => return true,
            };
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Character-level DP scorer
// ---------------------------------------------------------------------------

/// Classify a character for boundary detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CharClass {
    Lower,
    Upper,
    Digit,
    /// Non-ASCII alphanumeric: CJK ideographs, kana, etc.
    Other,
    Separator,
}

fn char_class(c: char) -> CharClass {
    if c.is_lowercase() {
        CharClass::Lower
    } else if c.is_uppercase() {
        CharClass::Upper
    } else if c.is_ascii_digit() {
        CharClass::Digit
    } else if c.is_alphanumeric() {
        CharClass::Other
    } else {
        CharClass::Separator
    }
}

fn is_boundary(prev: CharClass, curr: CharClass) -> bool {
    matches!(
        (prev, curr),
        (
            CharClass::Separator,
            CharClass::Lower | CharClass::Upper | CharClass::Digit | CharClass::Other
        )
    )
}

fn is_camel(prev: CharClass, curr: CharClass) -> bool {
    prev == CharClass::Lower && curr == CharClass::Upper
}

/// Character-level DP fuzzy scorer.
///
/// Caller should pre-filter via [`contains_chars`] before calling this —
/// the DP table is expensive and should only run on plausible matches.
///
/// Returns `None` if the query cannot be fully matched (defensive; shouldn't
/// happen after pre-filter).
pub fn fuzzy_score(query: &str, candidate: &str) -> Option<ScoredMatch> {
    let q: Vec<char> = query.chars().collect();
    let c: Vec<char> = candidate.chars().collect();
    let qlen = q.len();
    let clen = c.len();

    if qlen == 0 {
        return Some(ScoredMatch {
            score: 0,
            matches: vec![],
        });
    }
    if clen == 0 || qlen > clen {
        return None;
    }

    let rows = qlen + 1;
    let cols = clen + 1;

    // dp_match[i][j] = best score ending with q[i-1] matched at c[j-1]
    // dp_skip[i][j]  = best score with q[0..i] matched, c[j-1] skipped
    let mut dp_match = vec![i32::MIN / 2; rows * cols];
    let mut dp_skip = vec![i32::MIN / 2; rows * cols];
    let mut consecutive = vec![0i32; rows * cols];

    // Base case: matching 0 query chars against any prefix is score 0.
    for j in 0..cols {
        dp_match[j] = 0;
        dp_skip[j] = 0;
    }

    // Pre-compute character classes for boundary detection.
    let c_class: Vec<CharClass> = c.iter().map(|&ch| char_class(ch)).collect();

    for i in 1..rows {
        let qi = q[i - 1];
        let qi_folded = fold_case(qi);

        for j in i..cols {
            let cj = c[j - 1];
            let cj_folded = fold_case(cj);

            let idx = i * cols + j;
            let prev_best = dp_match[i * cols + (j - 1)].max(dp_skip[i * cols + (j - 1)]);

            if qi_folded == cj_folded {
                // Match: extend diagonal.
                let prev_match = dp_match[(i - 1) * cols + (j - 1)];
                let prev_skip = dp_skip[(i - 1) * cols + (j - 1)];
                let prev_consec = consecutive[(i - 1) * cols + (j - 1)];

                let mut match_score = SCORE_MATCH;

                // Consecutive bonus (only if previous was also a match, not a skip)
                if prev_consec > 0 && prev_match >= prev_skip {
                    match_score += SCORE_CONSECUTIVE;
                    consecutive[idx] = prev_consec + 1;
                } else {
                    consecutive[idx] = 1;
                }

                // First character bonus
                if j == 1 {
                    match_score += SCORE_FIRST_CHAR;
                }

                // Boundary bonus
                if j >= 2 {
                    let prev_class = c_class[j - 2];
                    let curr_class = c_class[j - 1];
                    if is_boundary(prev_class, curr_class) {
                        match_score += SCORE_BOUNDARY;
                    } else if is_camel(prev_class, curr_class) {
                        match_score += SCORE_CAMEL;
                    }
                }

                // Exact case bonus
                if qi == cj {
                    match_score += SCORE_CASE_EXACT;
                }

                let diag = prev_match.max(prev_skip);
                dp_match[idx] = diag + match_score;
            }

            // Skip: carry forward best score with gap penalty.
            if prev_best > i32::MIN / 2 {
                let prev_was_skip = dp_skip[i * cols + (j - 1)] > dp_match[i * cols + (j - 1)];
                let penalty = if prev_was_skip {
                    PENALTY_GAP_EXTENSION
                } else {
                    PENALTY_GAP_FIRST
                };
                dp_skip[idx] = prev_best + penalty;
            }
        }
    }

    let final_score = dp_match[qlen * cols + clen].max(dp_skip[qlen * cols + clen]);
    if final_score <= i32::MIN / 2 {
        return None;
    }

    // Backtrack to recover character positions.
    let char_positions = backtrack(&dp_match, &dp_skip, rows, cols);

    // Convert character positions to UTF-16 code unit offset ranges.
    let utf16 = utf16_offsets(&c);
    let matches = merge_to_utf16_ranges(&char_positions, &utf16);

    Some(ScoredMatch {
        score: final_score,
        matches,
    })
}

/// Backtrack through dp_match/dp_skip to recover matched character positions.
///
/// Returns a vector of 0-indexed character positions in the candidate.
fn backtrack(dp_match: &[i32], dp_skip: &[i32], rows: usize, cols: usize) -> Vec<usize> {
    let mut positions: Vec<usize> = Vec::with_capacity(rows - 1);
    let mut i = rows - 1;
    let mut j = cols - 1;

    let mut in_match = dp_match[i * cols + j] >= dp_skip[i * cols + j];

    while i > 0 && j > 0 {
        if in_match {
            positions.push(j - 1); // 0-indexed character position
            i -= 1;
            j -= 1;
            if i > 0 && j > 0 {
                in_match = dp_match[i * cols + j] >= dp_skip[i * cols + j];
            }
        } else {
            j -= 1;
            if j > 0 {
                in_match = dp_match[i * cols + j] >= dp_skip[i * cols + j];
            }
        }
    }

    positions.reverse();
    positions
}

/// Convert character positions to merged UTF-16 code unit offset ranges.
fn merge_to_utf16_ranges(char_positions: &[usize], utf16_offsets: &[usize]) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for &pos in char_positions {
        let start = utf16_offsets[pos];
        let end = utf16_offsets[pos + 1];
        if let Some(last) = ranges.last_mut() {
            if last.1 == start {
                last.1 = end;
                continue;
            }
        }
        ranges.push((start, end));
    }
    ranges
}

// ---------------------------------------------------------------------------
// Path-aware structural scorer (Layer 2)
// ---------------------------------------------------------------------------

/// Score a file path against a query with basename preference.
///
/// - If query contains `/`: score the full path.
/// - Otherwise: score basename first (with tier bonus), fall back to full path.
/// - Tiebreaking: shorter paths get a small bonus.
pub fn score_file_path(query: &str, path: &str) -> Option<ScoredMatch> {
    if query.is_empty() {
        return Some(ScoredMatch {
            score: 0,
            matches: vec![],
        });
    }

    if query.contains('/') {
        // User is explicitly path-matching.
        if !contains_chars(query, path) {
            return None;
        }
        let mut m = fuzzy_score(query, path)?;
        m.score -= path.chars().count() as i32; // shorter paths win ties
        return Some(m);
    }

    // Try basename first. A directory entry carries a trailing `/`;
    // its basename is the last real segment, so trim before splitting
    // — otherwise every directory would lose the basename tier.
    let trimmed = path.trim_end_matches('/');
    let basename_byte_start = trimmed.rfind('/').map_or(0, |i| i + 1);
    let basename = &trimmed[basename_byte_start..];
    // Convert byte offset to UTF-16 offset for position adjustment.
    let basename_utf16_start: usize = trimmed[..basename_byte_start]
        .chars()
        .map(|c| c.len_utf16())
        .sum();

    if !basename.is_empty() && contains_chars(query, basename) {
        if let Some(mut m) = fuzzy_score(query, basename) {
            // Adjust match positions to be relative to the full path (UTF-16 offsets).
            for range in &mut m.matches {
                range.0 += basename_utf16_start;
                range.1 += basename_utf16_start;
            }
            m.score += BASENAME_TIER_BONUS;
            m.score -= path.chars().count() as i32;
            return Some(m);
        }
    }

    // Fall back to full path.
    if !contains_chars(query, path) {
        return None;
    }
    let mut m = fuzzy_score(query, path)?;
    m.score -= path.chars().count() as i32; // shorter paths win ties
    Some(m)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // contains_chars
    // -----------------------------------------------------------------------

    #[test]
    fn prefilter_matches_subsequence() {
        assert!(contains_chars("sms", "session-metadata-store.ts"));
    }

    #[test]
    fn prefilter_rejects_missing_chars() {
        assert!(!contains_chars("xyz", "model.ts"));
    }

    #[test]
    fn prefilter_order_matters() {
        assert!(!contains_chars("sm", "ms"));
    }

    #[test]
    fn prefilter_case_insensitive() {
        assert!(contains_chars("btn", "ButtonGroup.tsx"));
    }

    #[test]
    fn prefilter_empty_query_matches_everything() {
        assert!(contains_chars("", "anything.rs"));
    }

    #[test]
    fn prefilter_empty_candidate_rejects_nonempty_query() {
        assert!(!contains_chars("a", ""));
    }

    #[test]
    fn prefilter_unicode_case_fold() {
        assert!(contains_chars("café", "Café.txt"));
    }

    #[test]
    fn prefilter_cjk_exact() {
        assert!(contains_chars("カタ", "カタカナ.txt"));
    }

    #[test]
    fn prefilter_hiragana_does_not_match_katakana() {
        assert!(!contains_chars("か", "カタカナ.txt"));
    }

    // -----------------------------------------------------------------------
    // fuzzy_score basics
    // -----------------------------------------------------------------------

    #[test]
    fn empty_query_scores_zero() {
        let m = fuzzy_score("", "anything").unwrap();
        assert_eq!(m.score, 0);
        assert!(m.matches.is_empty());
    }

    #[test]
    fn no_match_returns_none() {
        assert!(fuzzy_score("xyz", "model.ts").is_none());
    }

    #[test]
    fn exact_prefix_scores_high() {
        let m = fuzzy_score("model", "model.ts").unwrap();
        assert!(m.score > 0);
        assert_eq!(m.matches, vec![(0, 5)]);
    }

    #[test]
    fn case_insensitive_matching() {
        let m = fuzzy_score("model", "Model.ts").unwrap();
        assert!(m.score > 0);
        assert_eq!(m.matches, vec![(0, 5)]);
    }

    #[test]
    fn string_start_outranks_an_internal_boundary() {
        // `CLAUDE` against the real pair from the tugtool root: the file
        // whose stem IS the query must beat the dotdir whose match starts
        // after the dot. These tied before SCORE_FIRST_CHAR outranked
        // SCORE_BOUNDARY, and the shorter-path tiebreak then put `.claude/`
        // at the head of the completion popup.
        let file = score_file_path("CLAUDE", "CLAUDE.md").unwrap();
        let dotdir = score_file_path("CLAUDE", ".claude/").unwrap();
        assert!(
            file.score > dotdir.score,
            "CLAUDE.md ({}) must outrank .claude/ ({})",
            file.score,
            dotdir.score
        );
    }

    #[test]
    fn case_exact_bonus() {
        let exact = fuzzy_score("Model", "Model.ts").unwrap();
        let inexact = fuzzy_score("model", "Model.ts").unwrap();
        assert!(exact.score > inexact.score);
    }

    #[test]
    fn word_boundary_initials() {
        let m = fuzzy_score("sms", "session-metadata-store.ts").unwrap();
        assert!(m.score > 0);
        let total_matched: usize = m.matches.iter().map(|(s, e)| e - s).sum();
        assert_eq!(total_matched, 3, "should match exactly 3 characters");
    }

    #[test]
    fn camel_case_matching() {
        let m = fuzzy_score("bg", "ButtonGroup.tsx").unwrap();
        assert!(m.score > 0);
    }

    #[test]
    fn consecutive_chars_score_higher_than_scattered() {
        let consecutive = fuzzy_score("mod", "model.ts").unwrap();
        let scattered = fuzzy_score("mod", "maximum_override.ts").unwrap();
        assert!(
            consecutive.score > scattered.score,
            "consecutive ({}) should beat scattered ({})",
            consecutive.score,
            scattered.score
        );
    }

    #[test]
    fn match_positions_correct_for_highlighting() {
        let m = fuzzy_score("ft", "filetree.rs").unwrap();
        for (start, end) in &m.matches {
            assert!(*end <= "filetree.rs".len());
            assert!(start < end);
        }
    }

    // -----------------------------------------------------------------------
    // score_file_path (Layer 2)
    // -----------------------------------------------------------------------

    #[test]
    fn basename_preference() {
        let short = score_file_path("model", "model.ts").unwrap();
        let deep = score_file_path("model", "src/models/config.ts");
        if let Some(d) = deep {
            assert!(short.score > d.score);
        }
    }

    #[test]
    fn basename_match_beats_directory_match() {
        let basename_hit = score_file_path("model", "src/deep/model.ts").unwrap();
        let dir_only = score_file_path("model", "src/models/config.ts");
        if let Some(d) = dir_only {
            assert!(
                basename_hit.score > d.score,
                "basename hit ({}) should beat dir-only ({})",
                basename_hit.score,
                d.score
            );
        }
    }

    #[test]
    fn shorter_path_wins_on_tie() {
        let short = score_file_path("model", "model.ts").unwrap();
        let long = score_file_path("model", "src/deep/model.ts").unwrap();
        assert!(short.score > long.score);
    }

    #[test]
    fn query_with_slash_scores_full_path() {
        let m = score_file_path("src/comp", "src/components/Button.tsx").unwrap();
        assert!(m.score > 0);
        assert!(!m.matches.is_empty());
        assert_eq!(m.matches[0].0, 0);
    }

    #[test]
    fn nonmatch_returns_none() {
        assert!(score_file_path("xyz", "model.ts").is_none());
    }

    #[test]
    fn empty_query_returns_zero_score() {
        let m = score_file_path("", "anything.rs").unwrap();
        assert_eq!(m.score, 0);
    }

    #[test]
    fn basename_match_positions_are_path_relative() {
        let m = score_file_path("model", "src/lib/model.ts").unwrap();
        assert!(!m.matches.is_empty());
        // "src/lib/" is 8 chars, all ASCII → 8 UTF-16 code units.
        assert_eq!(
            m.matches[0].0, 8,
            "match should start at basename UTF-16 offset"
        );
    }

    #[test]
    fn sms_matches_session_metadata_store() {
        let m = score_file_path("sms", "src/lib/session-metadata-store.ts").unwrap();
        assert!(m.score > 0);
        assert!(m.score > BASENAME_TIER_BONUS / 2);
    }

    #[test]
    fn root_level_file_no_slash() {
        let m = score_file_path("cargo", "Cargo.toml").unwrap();
        assert!(m.score > 0);
        assert!(!m.matches.is_empty());
    }

    // -----------------------------------------------------------------------
    // Unicode case folding
    // -----------------------------------------------------------------------

    #[test]
    fn unicode_case_fold_accented() {
        let m = fuzzy_score("café", "Café.txt").unwrap();
        assert!(m.score > 0);
        // "café" matches "Café" case-insensitively.
        assert_eq!(m.matches, vec![(0, 4)]);
    }

    #[test]
    fn unicode_case_exact_bonus_accented() {
        let exact = fuzzy_score("Café", "Café.txt").unwrap();
        let inexact = fuzzy_score("café", "Café.txt").unwrap();
        assert!(exact.score > inexact.score);
    }

    // -----------------------------------------------------------------------
    // CJK matching
    // -----------------------------------------------------------------------

    #[test]
    fn cjk_exact_match() {
        let m = fuzzy_score("カタカナ", "カタカナ.txt").unwrap();
        assert!(m.score > 0);
        // 4 characters, all BMP → 4 UTF-16 code units, one contiguous range.
        assert_eq!(m.matches, vec![(0, 4)]);
    }

    #[test]
    fn cjk_partial_match() {
        let m = fuzzy_score("カタ", "カタカナ.txt").unwrap();
        assert!(m.score > 0);
        assert_eq!(m.matches, vec![(0, 2)]);
    }

    #[test]
    fn cjk_basename_in_path() {
        let m = score_file_path("カタカナ", "src/カタカナ.txt").unwrap();
        assert!(m.score > 0);
        // "src/" is 4 chars → 4 UTF-16 code units. Basename starts at offset 4.
        assert_eq!(m.matches[0].0, 4);
    }

    #[test]
    fn cjk_boundary_after_separator() {
        // `/` → `カ` should be a word boundary (Separator → Other).
        let with_boundary = fuzzy_score("カ", "x/カ.txt").unwrap();
        let no_boundary = fuzzy_score("カ", "xカ.txt").unwrap();
        // The boundary version should score higher.
        assert!(
            with_boundary.score > no_boundary.score,
            "boundary ({}) should beat no-boundary ({})",
            with_boundary.score,
            no_boundary.score
        );
    }

    #[test]
    fn cjk_no_boundary_between_same_class() {
        // `カ` → `タ` is Other → Other — NOT a boundary.
        let m = fuzzy_score("タ", "カタカナ.txt").unwrap();
        assert!(m.score > 0);
        // Should match at position 1 (the タ), no boundary bonus.
        assert_eq!(m.matches, vec![(1, 2)]);
    }

    // -----------------------------------------------------------------------
    // Emoji (astral plane / UTF-16 surrogate pairs)
    // -----------------------------------------------------------------------

    #[test]
    fn emoji_match_utf16_offsets() {
        let m = fuzzy_score("🎉", "🎉party.txt").unwrap();
        assert!(m.score > 0);
        // 🎉 is 1 codepoint but 2 UTF-16 code units.
        assert_eq!(m.matches, vec![(0, 2)]);
    }

    #[test]
    fn emoji_mid_path_offsets() {
        let m = score_file_path("party", "🎉/party.txt").unwrap();
        assert!(m.score > 0);
        // 🎉 = 2 UTF-16 code units, / = 1 → basename starts at UTF-16 offset 3.
        assert_eq!(m.matches[0].0, 3);
    }

    #[test]
    fn emoji_mixed_with_ascii() {
        let m = fuzzy_score("pt", "🎉party.txt").unwrap();
        assert!(m.score > 0);
        // 'p' at char index 1 → UTF-16 offset 2 (after 🎉's 2 code units).
        // 't' could be at char index 4 → UTF-16 offset 5... or contiguous 'pt' if found.
        // Just verify offsets are > 0 (past the emoji).
        assert!(m.matches[0].0 >= 2, "matches should start after emoji");
    }

    // -----------------------------------------------------------------------
    // Backtracker: correct word-boundary positions
    // -----------------------------------------------------------------------

    #[test]
    fn backtracker_recovers_boundary_positions_for_sms() {
        let m = fuzzy_score("sms", "session-metadata-store.ts").unwrap();
        // s(0), m(8), s(17) — all ASCII so UTF-16 offset = char index.
        assert_eq!(
            m.matches,
            vec![(0, 1), (8, 9), (17, 18)],
            "should match word-boundary initials s(0), m(8), s(17)"
        );
    }

    // -----------------------------------------------------------------------
    // Gap penalty
    // -----------------------------------------------------------------------

    #[test]
    fn gap_start_penalized_more_than_extension() {
        let short_gap = fuzzy_score("ab", "axb").unwrap();
        let long_gap = fuzzy_score("ab", "axxxb").unwrap();
        assert!(
            short_gap.score > long_gap.score,
            "shorter gap ({}) should beat longer gap ({})",
            short_gap.score,
            long_gap.score
        );
    }
}

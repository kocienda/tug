/**
 * The session-reference grammar — what might name a session in ink.
 *
 * Three spellings, and only three:
 *
 *  - A **full session uuid** (`8-4-4-4-12`, lowercase hex). Collision-free by
 *    construction — nothing else in prose looks like one — so it needs no
 *    other evidence to be worth asking about.
 *  - A **`project/callsign` pair**, where the callsign half is a session's
 *    mnemonic: two lowercase words, plus the fork lineage suffix when there
 *    is one (`tugtool/quirky-hull`, `tugtool/stocky-pixie-A1`,
 *    `tugtool/stocky-pixie-A1-B2`). The lineage segments are the ledger's own
 *    sanctioned suffix — `<Letter><Number>`, allocated per fork point — and
 *    the grammar takes them because `sessions.tag` holds the COMPOSED
 *    callsign; without them a forked session would be undetectable by
 *    construction.
 *  - A **short id**: a uuid's first eight characters, lowercase hex with at
 *    least one digit. It is the spelling `tugtool session find` takes, the
 *    one a `Tug-Session:` trailer parenthesizes, and the one a model reaches
 *    for when it names a session in passing ("the cf3328c3 session"). The
 *    resolver answers it by prefix and refuses an ambiguous one. It is also
 *    shaped exactly like a short commit sha, so the commit scan finds the
 *    same run; which one claims it is settled in `annotate-content.ts`
 *    (`sessionMatch`), never by this grammar.
 *
 * A **bare callsign** is deliberately not scanned. `kind-floor` is shaped like
 * every hyphenated compound in English, and scanning it would cost a resolver
 * round trip per false positive while painting chips over ordinary words. The
 * project half is what makes the pair worth its characters: it is evidence,
 * checked against the answer's own `projectDir` before the candidate counts
 * (see `session-resolution.ts`).
 *
 * Like every other detector here, this is not the filter — the ledger is. A
 * candidate that names no session resolves to nothing and stays plain text.
 *
 * @module lib/annotator/detect-session-ref
 */

/** A session reference found in ink, with the offsets it occupies. */
export interface SessionRefMatch {
  /** The reference as written — a uuid, or a `project/callsign` pair. */
  target: string;
  /** Index of the reference's first character in the scanned text. */
  start: number;
  /** Index one past the reference's last character. */
  end: number;
}

/** Runs of whitespace-free text — the unit a reference can occupy. */
const TOKEN_RE = /\S+/g;

/** Punctuation that can wrap a reference in prose without being part of it. */
const LEADING_PUNCTUATION = /^[([{<'"`,;:]+/;
const TRAILING_PUNCTUATION = /[)\]}>'"`,;:.!?]+$/;

/** A full session uuid: 8-4-4-4-12 lowercase hex. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A short session id: a uuid's leading eight hex characters. The digit rule
 * is the commit grammar's, for the commit grammar's reason — it keeps the
 * all-letter hex words of English (`effacebd` and kin) out of the question.
 */
const SHORT_ID_RE = /^[0-9a-f]{8}$/;
const HAS_DIGIT = /[0-9]/;

/**
 * A `project/callsign` pair.
 *
 * The project half is one path segment with no dots — a repository leaf name,
 * which is what `projectDir`'s basename is. Excluding dots is what keeps
 * `tugdeck/src` and `docs/notes.md` out: a real relative path's leaf usually
 * carries an extension, and the callsign half's own shape rejects the rest.
 *
 * The callsign half is `word-word`, optionally followed by lineage segments.
 * No digits in the words, because a callsign is a mnemonic pair; digits appear
 * only inside a lineage segment, where they are preceded by a capital.
 */
const PAIR_RE = /^([a-z][a-z0-9_-]*)\/([a-z]+-[a-z]+(?:-[A-Z][0-9]+)*)$/;

/** Whether `text` is exactly one session-reference candidate. */
export function isSessionRef(text: string): boolean {
  return UUID_RE.test(text) || PAIR_RE.test(text) || isSessionShortId(text);
}

/**
 * Whether `text` is a short session id — the one session spelling that is
 * also a commit-sha candidate, and so the one that contends with the commit
 * scan for its run.
 */
export function isSessionShortId(text: string): boolean {
  return SHORT_ID_RE.test(text) && HAS_DIGIT.test(text);
}

/**
 * Every session-reference candidate in `text`, with the offsets it occupies.
 * Offsets are into `text` as given, so a caller can wrap the exact run in
 * place; wrapping punctuation is peeled and excluded from the range.
 */
export function scanSessionRefs(text: string): SessionRefMatch[] {
  const matches: SessionRefMatch[] = [];
  TOKEN_RE.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = TOKEN_RE.exec(text)) !== null) {
    const raw = token[0];
    const leading = LEADING_PUNCTUATION.exec(raw)?.[0].length ?? 0;
    const target = raw.slice(leading).replace(TRAILING_PUNCTUATION, "");
    if (!isSessionRef(target)) continue;
    const start = token.index + leading;
    matches.push({ target, start, end: start + target.length });
  }
  return matches;
}

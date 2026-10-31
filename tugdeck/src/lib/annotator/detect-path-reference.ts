/**
 * The file-path grammar — what *might* be a path reference in transcript
 * ink, before anything checks whether it exists.
 *
 * This grammar is deliberately permissive, because it is not the safety
 * mechanism. Resolution is: a candidate becomes an annotation only once
 * the filesystem (or the project's file index) confirms a real file, so a
 * candidate that is merely prose costs one cached lookup and stays plain
 * text. A grammar strict enough to also serve as a false-positive filter
 * would be doing a job that is already done, and would pay for it by
 * throwing away the shapes Claude actually writes — a bare
 * `tug-button.css` in a sentence, or a path sitting inside a longer
 * command line.
 *
 * So the rules here only ask whether a token *could* name a file:
 *
 *  - It has no whitespace. A path is one token; this is what lets a path
 *    be found inside a sentence at all.
 *  - It carries no `scheme://` — that is a URL, and a different kind.
 *  - It does not begin with `~`. Resolving home-relative forms would need
 *    a client-side home-derivation rule nothing else needs yet.
 *  - It either carries a `/` (resolved against the session cwd), or it is
 *    a bare `name.ext` (resolved through the project's file index, the
 *    same search Open Quickly runs). A bare name's extension must contain
 *    a letter, which costs nothing and keeps version numbers and decimals
 *    out of the index.
 *
 * A trailing `:N` or `:N:C` is a line (and column) citation — the shape a
 * compiler, a grep, and Claude all write. The column is parsed and
 * discarded, since opening a file addresses lines.
 *
 * Pure and total: callers decide what to do with a candidate, and whether
 * it resolves to a real file is a separate question the resolvers answer.
 *
 * @module lib/annotator/detect-path-reference
 */

/** A path reference detected in ink, with its optional line citation. */
export interface PathReference {
  /** The path as written — absolute, cwd-relative, or a bare filename. */
  path: string;
  /** 1-based line the reference cites, when it cites one. */
  line?: number;
  /** 1-based last line of a cited range; `line` is its first. */
  endLine?: number;
  /**
   * How the path has to be resolved. A `path` carries a `/` and resolves
   * against the session cwd; a `name` is bare and resolves through the
   * project's file index.
   */
  shape: "path" | "name";
}

/** A {@link PathReference} located within a larger string. */
export interface PathReferenceMatch extends PathReference {
  /** Index of the reference's first character in the scanned text. */
  start: number;
  /** Index one past the reference's last character. */
  end: number;
}

/** A `scheme://` prefix — a URL, not a path. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Runs of whitespace-free text — the unit a path can occupy. */
const TOKEN_RE = /\S+/g;

/** Punctuation that can precede a path in prose without being part of it. */
const LEADING_PUNCTUATION = /^[([{<'"`,;]+/;

/**
 * Punctuation that can follow a path in prose without being part of it.
 * A trailing `:` goes too — `see foo.ts:` cites the file, not line zero —
 * but a `:12` suffix ends in a digit and so survives to be parsed as the
 * line citation it is.
 */
const TRAILING_PUNCTUATION = /[)\]}>'"`,;:.!?]+$/;

/** A bare filename: no separators, and an extension carrying a letter. */
const BARE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._+-]*\.[A-Za-z0-9]{0,9}[A-Za-z][A-Za-z0-9]{0,9}$/;

/** All-digit text, for recognizing a `:N` citation suffix. */
const DIGITS_RE = /^\d+$/;

/** A cited line range: `:124-135`. */
const RANGE_CITATION_RE = /^(\d+)-(\d+)$/;

/**
 * Split a trailing line citation off `token`, returning the path part, the
 * lines it cites, and how many characters of `token` the reference
 * occupies.
 *
 * Three shapes, all of which this corpus writes:
 *
 *  - `path:N` — a line, what a compiler and a grep produce.
 *  - `path:N:C` — a line and column; the column is parsed and discarded,
 *    since opening a file addresses lines.
 *  - `path:N-M` — a range, which is how prose cites a function or a
 *    docstring. Both ends are kept: the gesture reveals the whole span.
 *
 * A citation that does not parse — line zero, a backwards range — is
 * dropped along with the characters that spelled it, so the run reported
 * to the caller never includes text the annotation ignores.
 */
export function splitLineCitation(token: string): {
  path: string;
  line?: number;
  endLine?: number;
  consumed: number;
} {
  const colon = token.lastIndexOf(":");
  if (colon > 0) {
    const range = RANGE_CITATION_RE.exec(token.slice(colon + 1));
    if (range !== null) {
      const path = token.slice(0, colon);
      const line = Number.parseInt(range[1], 10);
      const endLine = Number.parseInt(range[2], 10);
      return line >= 1 && endLine >= line
        ? { path, line, endLine, consumed: token.length }
        : { path, consumed: path.length };
    }
  }

  let path = token;
  const numbers: number[] = [];
  while (numbers.length < 2) {
    const at = path.lastIndexOf(":");
    if (at <= 0) break;
    const tail = path.slice(at + 1);
    if (!DIGITS_RE.test(tail)) break;
    numbers.unshift(Number.parseInt(tail, 10));
    path = path.slice(0, at);
  }
  const line = numbers[0];
  return line === undefined || line < 1
    ? { path, consumed: path.length }
    : { path, line, consumed: token.length };
}

/**
 * How `path` would have to be resolved, or `null` when it cannot name a
 * file at all.
 */
function pathShape(path: string): PathReference["shape"] | null {
  if (path === "" || path.startsWith("~")) return null;
  if (HAS_SCHEME.test(path)) return null;
  if (path.includes("/")) return "path";
  return BARE_NAME_RE.test(path) ? "name" : null;
}

/**
 * Drop a trailing separator. A directory can be written either way and
 * means the same place; the resolvers want the path form.
 */
function trimTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Every path-shaped token in `text`, with the offsets it occupies. Offsets
 * are into `text` as given, so a caller can wrap the exact run in place.
 *
 * Surrounding punctuation is peeled before matching and excluded from the
 * reported range, so a path at the end of a sentence is found without the
 * period being swallowed into the link.
 */
export function scanPathReferences(text: string): PathReferenceMatch[] {
  const matches: PathReferenceMatch[] = [];
  TOKEN_RE.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = TOKEN_RE.exec(text)) !== null) {
    const raw = token[0];
    const leading = LEADING_PUNCTUATION.exec(raw)?.[0].length ?? 0;
    const body = raw.slice(leading).replace(TRAILING_PUNCTUATION, "");
    if (body === "") continue;
    const { path: written, line, endLine, consumed } = splitLineCitation(body);
    const shape = pathShape(written);
    if (shape === null) continue;
    const path = trimTrailingSlash(written);
    const start = token.index + leading;
    const match: PathReferenceMatch = {
      path,
      shape,
      start,
      end: start + consumed,
    };
    if (line !== undefined) match.line = line;
    if (endLine !== undefined) match.endLine = endLine;
    matches.push(match);
  }
  return matches;
}

/**
 * Parse `text` as a whole path reference, or return `null` when it is not
 * exactly one. This is the inline-`<code>` case, where the span's own
 * boundaries say "this is a path" and the whole span becomes the
 * annotation rather than a run inside it.
 */
export function detectPathReference(text: string): PathReference | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const matches = scanPathReferences(trimmed);
  if (matches.length !== 1) return null;
  const only = matches[0];
  if (only.start !== 0 || only.end !== trimmed.length) return null;
  const { start: _start, end: _end, ...reference } = only;
  return reference;
}

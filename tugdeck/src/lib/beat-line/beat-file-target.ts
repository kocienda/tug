/**
 * beat-file-target — recognize the file target inside a beat.
 *
 * The voice narrates file tools in a fixed grammar — `Reading <path>`,
 * `Writing <path> — 37 lines`, `Editing <path>…`, optionally prefixed with a
 * subagent label (`Explore · Reading <path>`) — and carries the path WHOLE on
 * the wire, absolute when the session's root could not account for it. The
 * deck's surfaces do not show that path as text: a file is shown as a file
 * reference — glyph + basename, full path on hover — and this module is the
 * one grammar that says where the path sits in the beat so every surface
 * splits it identically.
 *
 * Recognition is deliberately narrow. Only the three file verbs match, the
 * candidate must be a single whitespace-free token, and it must actually read
 * as a path — a `/` somewhere, or a dotted file suffix. A monologue sentence
 * that happens to open "Reading the docs." fails both gates and renders as
 * the prose it is.
 *
 * @module lib/beat-line/beat-file-target
 */

/** A beat split around its file target. */
export interface BeatFileTarget {
  /** Everything before the path, trailing space included (`"Editing "`). */
  head: string;
  /** The file path, exactly as the beat carries it. */
  path: string;
  /** Everything after the path (`" — 37 lines"`, `"…"`, or `""`). */
  tail: string;
}

/** The voice's file-tool beat: optional label prefix, verb, target, suffix. */
const BEAT_GRAMMAR = /^(.*?\b(?:Reading|Writing|Editing) )(\S+?)((?: — \d+ lines?)?…?)$/;

/** A token that reads as a path: a separator, or a dotted file suffix. */
function isPathlike(token: string): boolean {
  if (token.length === 0) return false;
  return token.includes("/") || /\.[\w-]{1,12}$/.test(token);
}

/**
 * Split a beat around its file target, or `null` when the beat carries none.
 * Total and pure — callers fall back to rendering the text as it stands.
 */
export function parseBeatFileTarget(text: string): BeatFileTarget | null {
  const match = BEAT_GRAMMAR.exec(text);
  if (match === null) return null;
  const [, head, candidate, tail] = match;
  if (!isPathlike(candidate)) return null;
  return { head, path: candidate, tail };
}

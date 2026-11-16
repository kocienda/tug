/**
 * The arc-reference grammar — what might name an arc in transcript ink.
 *
 * An arc is written `arc:<name>`, the spelling a chart's refs use and the one
 * an arc annotation copies as. The name is the arc log's grammar: a lowercase
 * letter or digit, then lowercase letters, digits and hyphens, at most 120
 * characters. Like the commit grammar, this does not decide whether the arc
 * exists — the project's arc log does, and a name it does not hold stays
 * plain text. What this does is keep the question worth asking.
 *
 * The prefix must start a word: `xarc:foo` is not a reference, and a name
 * stops at the first character the grammar does not allow, so trailing
 * punctuation in a sentence is never part of it.
 *
 * @module lib/annotator/detect-arc-ref
 */

/** An arc reference found in ink, with the offsets it occupies. */
export interface ArcRefMatch {
  /** The arc's name, without the `arc:` prefix. */
  name: string;
  /** Index of the reference's first character (the `a` of `arc:`). */
  start: number;
  /** Index one past the name's last character. */
  end: number;
}

/** The longest name the arc log's grammar allows. */
const MAX_NAME = 120;

/**
 * `arc:` at a word start, then a name. A trailing hyphen is peeled below
 * rather than excluded here, so the match still begins where the reference
 * does.
 */
const ARC_REF_RE = /(?<![A-Za-z0-9_-])arc:([a-z0-9][a-z0-9-]*)/g;

/** Every arc reference in `text`, with the offsets it occupies. */
export function scanArcRefs(text: string): ArcRefMatch[] {
  const matches: ArcRefMatch[] = [];
  ARC_REF_RE.lastIndex = 0;
  let found: RegExpExecArray | null;
  while ((found = ARC_REF_RE.exec(text)) !== null) {
    // A hyphen ending a sentence's word (`arc:foo-`) is punctuation, not
    // part of the name.
    const name = found[1].replace(/-+$/, "");
    if (name === "" || name.length > MAX_NAME) continue;
    // A name running straight on into more word characters the grammar
    // refuses (an uppercase letter, an underscore) is not this reference.
    const after = text[found.index + 4 + found[1].length];
    if (after !== undefined && /[A-Za-z0-9_]/.test(after)) continue;
    const start = found.index;
    matches.push({ name, start, end: start + 4 + name.length });
  }
  return matches;
}

/**
 * A join refusal, read into the receipt row grammar: one sentence, then one
 * path per row.
 *
 * The server writes why a resolve stopped as a single string — the durable
 * stuck line and the ledger's `ended` detail are the same sentence — and
 * several of those sentences carry a list of files inside them: the paths a
 * resolver's report left unaccounted for, the ones it rewrote outside the
 * conflicts, and, in ledgers written before the join stopped examining
 * candidates, the shell-quoted selection a check command was expanded over.
 * Shown as prose, twenty paths are a paragraph with no red in it. Read here,
 * the list comes out as rows and the sentence says how many, so both seats
 * that show a refusal — the fold's band and the ledger's withheld candidate —
 * draw the same block from the same string, and a string this reader does not
 * recognise is still shown whole as its own sentence.
 *
 * @module lib/join-refusal
 */

/** A refusal as the fold and the ledger draw it. */
export interface JoinRefusal {
  /** The sentence row. Never empty for a non-empty detail. */
  sentence: string;
  /** One row per path the sentence named, in the order it named them. */
  paths: string[];
}

/**
 * A check's failure as the retired candidate exam wrote it: the surface, the
 * expanded command in backticks, the exit code, and the first red's title
 * when its child recorded one. Any prose before the surface is kept.
 */
const CHECK_SENTENCE =
  /^(?<prefix>.*?)(?<surface>[A-Za-z0-9_-]+): `(?<command>[^`]+)` \(exit (?<code>-?\d+)\)(?: · first red (?<title>.+))?$/;

/** One `sh`-quoted word, as `tugarc-core`'s `shell_quote` writes it. */
const QUOTED_WORD = /'((?:[^']|'\\'')*)'/g;

/**
 * A sentence that ends on a comma-separated list of paths — `… in a.rs, b.rs`,
 * `… does not account for a.rs` — with at most a short clause after the list.
 */
const PATH_LIST_SENTENCE =
  /^(?<before>.+?\b(?:in|for|changed|left)) (?<list>[^\s,()]+(?:, [^\s,()]+)*)(?<after>(?: without accounting for it| \(not a content conflict\))?)$/;

/** A token that reads as a path rather than a word: it has a slash or an extension. */
function pathLike(token: string): boolean {
  return token.includes("/") || /\.[A-Za-z0-9]+$/.test(token);
}

function filesWord(n: number): string {
  return n === 1 ? "1 file" : `${n} files`;
}

/** Read a check sentence's quoted selection out of its command. */
function readCheck(detail: string): JoinRefusal | null {
  const m = CHECK_SENTENCE.exec(detail);
  if (m?.groups === undefined) return null;
  const { prefix, surface, command, code, title } = m.groups as {
    prefix: string;
    surface: string;
    command: string;
    code: string;
    title?: string;
  };
  const paths: string[] = [];
  const head = command
    .replace(QUOTED_WORD, (_whole, body: string) => {
      paths.push(body.replace(/'\\''/g, "'"));
      return "";
    })
    .replace(/\s+/g, " ")
    .trim();
  const red = title !== undefined ? `, first red ${title}` : "";
  return {
    sentence: `${prefix}${surface} ran \`${head}\`, exit ${code}${red}`,
    paths,
  };
}

/** Read a trailing path list out of a resolver's refusal. */
function readPathList(detail: string): JoinRefusal | null {
  const m = PATH_LIST_SENTENCE.exec(detail);
  if (m?.groups === undefined) return null;
  const { before, list, after } = m.groups as { before: string; list: string; after: string };
  const paths = list.split(", ");
  // One token that reads as a path makes the list one: a bare `Justfile` or
  // `LICENSE` is a path too, and only a list with no path in it is prose.
  if (!paths.some(pathLike)) return null;
  return { sentence: `${before} ${filesWord(paths.length)}${after}`, paths };
}

/**
 * Read a refusal string into its sentence and its paths. A string that
 * names no list is its own sentence with no rows.
 */
export function parseJoinRefusal(detail: string): JoinRefusal {
  return readCheck(detail) ?? readPathList(detail) ?? { sentence: detail, paths: [] };
}

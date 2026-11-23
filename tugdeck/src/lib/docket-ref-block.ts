/**
 * docket-ref-block.ts — the trailing block that tells the model what each
 * docket reference in a message actually names.
 *
 * A docket atom reaches the model as `` `@docket:<id>` ``. The id is unique on
 * the machine, but the store that holds it lives in one checkout's state
 * directory, so the block says the docket's name, which checkout owns it, how
 * many threads it gathers, whether it is retired, and whether it can be read
 * from here.
 *
 * ```text
 * <!-- tug:docket-refs -->
 * Docket references in this message (read one with the command shown; do not guess at what a reference means):
 * - @docket:3f9a1c2e — "GPU wedge", project /Users/k/src/tug, threads 4, verdict: here — read: tugtool docket show 3f9a1c2e
 * - @docket:00ff00ff — verdict: absent — this docket is not on this machine
 * - @docket:12ab34cd — verdict: unverified — check: tugtool docket show 12ab34cd
 * ```
 *
 * The sketch block's shape (`sketch-ref-block.ts`): stripped on the way back
 * in, `null` for no entries, every verdict said out loud, and a forgiving
 * line-based parse. Pure, with no imports.
 *
 * @module lib/docket-ref-block
 */

/** The HTML comment that opens the block — the marker every reader keys on. */
export const DOCKET_REFS_MARKER = "<!-- tug:docket-refs -->";

/** The instruction line, directly under the marker. */
const DOCKET_REFS_HEADING =
  "Docket references in this message (read one with the command shown; do not guess at what a reference means):";

/** What the client knows about one reference at the moment it is sent. */
export type DocketRefVerdict = "here" | "elsewhere" | "absent" | "unverified";

/** One reference's row in the block. */
export interface DocketRefEntry {
  /** The docket id — the atom's value and the marker's spelling. */
  value: string;
  verdict: DocketRefVerdict;
  /** The docket's name. */
  name?: string;
  /** The checkout whose store holds the docket. */
  projectDir?: string;
  /** How many threads the docket gathers. */
  threads?: number;
  /** Whether the docket is retired. */
  retired?: boolean;
}

/** The identity a parsed line recovers, for a replay to put back on the atom. */
export interface ParsedDocketRef {
  value: string;
  name: string;
  projectDir: string;
  verdict: DocketRefVerdict;
}

/** Whether a text block IS the docket reference block. */
export function isDocketRefBlock(text: string): boolean {
  return text.startsWith(DOCKET_REFS_MARKER);
}

/**
 * A name inside the line's quotes. A `"` in it would end the quotes early for
 * a reader, so it is written as `'`; the chip still wears the real name.
 */
function quotedName(name: string): string {
  return `"${name.replace(/"/g, "'")}"`;
}

/**
 * One entry's line. `tugtool docket show` finds an id under any checkout, so
 * the read is the same command whichever project owns it.
 */
function refLine(entry: DocketRefEntry): string {
  const head = `- @docket:${entry.value}`;
  if (entry.verdict === "absent") {
    return `${head} — verdict: absent — this docket is not on this machine`;
  }
  const read = `tugtool docket show ${entry.value}`;
  if (
    entry.verdict === "unverified" ||
    entry.projectDir === undefined ||
    entry.name === undefined
  ) {
    return `${head} — verdict: ${entry.verdict} — check: ${read}`;
  }
  const facts = [quotedName(entry.name), `project ${entry.projectDir}`];
  if (entry.threads !== undefined) facts.push(`threads ${entry.threads}`);
  if (entry.retired === true) facts.push("retired");
  facts.push(`verdict: ${entry.verdict}`);
  return `${head} — ${facts.join(", ")} — read: ${read}`;
}

/**
 * Build the block for a message's docket references, or `null` when there
 * are none, so a message with no docket atom is byte-identical to before.
 */
export function buildDocketRefBlock(
  entries: readonly DocketRefEntry[],
): string | null {
  if (entries.length === 0) return null;
  return [DOCKET_REFS_MARKER, DOCKET_REFS_HEADING, ...entries.map(refLine)].join(
    "\n",
  );
}

/** A line that carried an identity; the lazy dir stops at the first tail. */
const REF_LINE_RE =
  /^- @docket:(\S+) — "([^"]*)", project (.+?)(?:, threads \d+)?(?:, retired)?, verdict: (here|elsewhere|absent|unverified)\b/;

/**
 * Parse the identities out of a block. Line-based and forgiving: a line this
 * reader does not recognise is skipped, never a reason to refuse the message.
 */
export function parseDocketRefBlock(text: string): ParsedDocketRef[] {
  if (!isDocketRefBlock(text)) return [];
  const out: ParsedDocketRef[] = [];
  for (const line of text.split("\n")) {
    const m = REF_LINE_RE.exec(line);
    if (m === null) continue;
    out.push({
      value: m[1],
      name: m[2],
      projectDir: m[3],
      verdict: m[4] as DocketRefVerdict,
    });
  }
  return out;
}

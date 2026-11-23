/**
 * sketch-ref-block.ts — the trailing block that tells the model what each
 * sketch reference in a message actually names.
 *
 * A sketch atom reaches the model as `` `@sketch:<id>` ``. The id is unique on
 * the machine, but the store that holds it lives in one checkout's state
 * directory, so the block says which checkout owns it, the arc it belongs to,
 * how many versions it has, and whether it can be read from here.
 *
 * ```text
 * <!-- tug:sketch-refs -->
 * Sketch references in this message (read one with the command shown; do not guess at what a reference means):
 * - @sketch:3f9a1c2e — project /Users/k/src/tug, arc gpu-wedge, versions 3, verdict: here — read: tugtool sketch show 3f9a1c2e
 * - @sketch:00ff00ff — verdict: absent — this sketch is not on this machine
 * - @sketch:12ab34cd — verdict: unverified — check: tugtool sketch show 12ab34cd
 * ```
 *
 * The session block's shape (`session-ref-block.ts`): stripped on the way back
 * in, `null` for no entries, every verdict said out loud, and a forgiving
 * line-based parse. Pure, with no imports.
 *
 * @module lib/sketch-ref-block
 */

/** The HTML comment that opens the block — the marker every reader keys on. */
export const SKETCH_REFS_MARKER = "<!-- tug:sketch-refs -->";

/** The instruction line, directly under the marker. */
const SKETCH_REFS_HEADING =
  "Sketch references in this message (read one with the command shown; do not guess at what a reference means):";

/** What the client knows about one reference at the moment it is sent. */
export type SketchRefVerdict = "here" | "elsewhere" | "absent" | "unverified";

/** One reference's row in the block. */
export interface SketchRefEntry {
  /** The sketch id — the atom's value and the marker's spelling. */
  value: string;
  verdict: SketchRefVerdict;
  /** The checkout whose store holds the sketch. */
  projectDir?: string;
  /** The arc the sketch belongs to, where it has one. */
  arc?: string;
  /** How many versions the sketch has. */
  versions?: number;
}

/** The identity a parsed line recovers, for a replay to put back on the atom. */
export interface ParsedSketchRef {
  value: string;
  projectDir: string;
  verdict: SketchRefVerdict;
}

/** Whether a text block IS the sketch reference block. */
export function isSketchRefBlock(text: string): boolean {
  return text.startsWith(SKETCH_REFS_MARKER);
}

/**
 * One entry's line. `tugtool sketch show` finds an id under any checkout, so
 * the read is the same command whichever project owns it.
 */
function refLine(entry: SketchRefEntry): string {
  const head = `- @sketch:${entry.value}`;
  if (entry.verdict === "absent") {
    return `${head} — verdict: absent — this sketch is not on this machine`;
  }
  const read = `tugtool sketch show ${entry.value}`;
  if (entry.verdict === "unverified" || entry.projectDir === undefined) {
    return `${head} — verdict: ${entry.verdict} — check: ${read}`;
  }
  const facts = [`project ${entry.projectDir}`];
  if (entry.arc !== undefined && entry.arc !== "") facts.push(`arc ${entry.arc}`);
  if (entry.versions !== undefined) facts.push(`versions ${entry.versions}`);
  facts.push(`verdict: ${entry.verdict}`);
  return `${head} — ${facts.join(", ")} — read: ${read}`;
}

/**
 * Build the block for a message's sketch references, or `null` when there
 * are none, so a message with no sketch atom is byte-identical to before.
 */
export function buildSketchRefBlock(
  entries: readonly SketchRefEntry[],
): string | null {
  if (entries.length === 0) return null;
  return [SKETCH_REFS_MARKER, SKETCH_REFS_HEADING, ...entries.map(refLine)].join(
    "\n",
  );
}

/** A line that carried an identity; the lazy dir stops at the first tail. */
const REF_LINE_RE =
  /^- @sketch:(\S+) — project (.+?)(?:, arc \S+)?(?:, versions \d+)?, verdict: (here|elsewhere|absent|unverified)\b/;

/**
 * Parse the identities out of a block. Line-based and forgiving: a line this
 * reader does not recognise is skipped, never a reason to refuse the message.
 */
export function parseSketchRefBlock(text: string): ParsedSketchRef[] {
  if (!isSketchRefBlock(text)) return [];
  const out: ParsedSketchRef[] = [];
  for (const line of text.split("\n")) {
    const m = REF_LINE_RE.exec(line);
    if (m === null) continue;
    out.push({
      value: m[1],
      projectDir: m[2],
      verdict: m[3] as SketchRefVerdict,
    });
  }
  return out;
}

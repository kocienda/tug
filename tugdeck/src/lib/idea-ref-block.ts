/**
 * idea-ref-block.ts — the trailing block that tells the model what each idea
 * reference in a message actually names.
 *
 * An idea atom reaches the model as `` `@idea:<id>` ``. The id is unique on
 * the machine, but the store that holds it lives in one checkout's state
 * directory, so the block says the idea's line, which checkout owns it, the
 * docket it is filed on, the sketch kept from it, and whether it can be read
 * from here.
 *
 * ```text
 * <!-- tug:idea-refs -->
 * Idea references in this message (read one with the command shown; do not guess at what a reference means):
 * - @idea:1a2b3c4d — "An inbox for ideas", project /Users/k/src/tug, docket Inbox, sketch 0a1b2c3d, verdict: here — read: tugtool idea show 1a2b3c4d
 * - @idea:00ff00ff — verdict: absent — this idea is not on this machine
 * - @idea:12ab34cd — verdict: unverified — check: tugtool idea show 12ab34cd
 * ```
 *
 * The docket block's shape (`docket-ref-block.ts`): stripped on the way back
 * in, `null` for no entries, every verdict said out loud, and a forgiving
 * line-based parse. Pure, with no imports.
 *
 * @module lib/idea-ref-block
 */

/** The HTML comment that opens the block — the marker every reader keys on. */
export const IDEA_REFS_MARKER = "<!-- tug:idea-refs -->";

/** The instruction line, directly under the marker. */
const IDEA_REFS_HEADING =
  "Idea references in this message (read one with the command shown; do not guess at what a reference means):";

/** What the client knows about one reference at the moment it is sent. */
export type IdeaRefVerdict = "here" | "elsewhere" | "absent" | "unverified";

/** One reference's row in the block. */
export interface IdeaRefEntry {
  /** The idea id — the atom's value and the marker's spelling. */
  value: string;
  verdict: IdeaRefVerdict;
  /** The idea's one line. */
  text?: string;
  /** The checkout whose store holds the idea. */
  projectDir?: string;
  /** The name of the docket the idea is filed on; absent when on none. */
  docket?: string;
  /** The id of the sketch kept from the idea; absent when none is. */
  sketch?: string;
}

/** The identity a parsed line recovers, for a replay to put back on the atom. */
export interface ParsedIdeaRef {
  value: string;
  text: string;
  projectDir: string;
  verdict: IdeaRefVerdict;
}

/** Whether a text block IS the idea reference block. */
export function isIdeaRefBlock(text: string): boolean {
  return text.startsWith(IDEA_REFS_MARKER);
}

/**
 * A line inside the block's quotes. A `"` in it would end the quotes early for
 * a reader, so it is written as `'`; the chip still wears the real line.
 */
function quotedText(text: string): string {
  return `"${text.replace(/"/g, "'")}"`;
}

/**
 * One entry's line. `tugtool idea show` finds an id under any checkout, so the
 * read is the same command whichever project owns it.
 */
function refLine(entry: IdeaRefEntry): string {
  const head = `- @idea:${entry.value}`;
  if (entry.verdict === "absent") {
    return `${head} — verdict: absent — this idea is not on this machine`;
  }
  const read = `tugtool idea show ${entry.value}`;
  if (
    entry.verdict === "unverified" ||
    entry.projectDir === undefined ||
    entry.text === undefined
  ) {
    return `${head} — verdict: ${entry.verdict} — check: ${read}`;
  }
  const facts = [
    quotedText(entry.text),
    `project ${entry.projectDir}`,
    `docket ${entry.docket ?? "none"}`,
    `sketch ${entry.sketch ?? "none"}`,
    `verdict: ${entry.verdict}`,
  ];
  return `${head} — ${facts.join(", ")} — read: ${read}`;
}

/**
 * Build the block for a message's idea references, or `null` when there are
 * none, so a message with no idea atom is byte-identical to before.
 */
export function buildIdeaRefBlock(entries: readonly IdeaRefEntry[]): string | null {
  if (entries.length === 0) return null;
  return [IDEA_REFS_MARKER, IDEA_REFS_HEADING, ...entries.map(refLine)].join("\n");
}

/**
 * A line that carried an identity. The project's lazy match stops at the
 * docket fact, which every identified line carries.
 */
const REF_LINE_RE =
  /^- @idea:(\S+) — "([^"]*)", project (.+?), docket .+?, sketch \S+, verdict: (here|elsewhere|absent|unverified)\b/;

/**
 * Parse the identities out of a block. Line-based and forgiving: a line this
 * reader does not recognise is skipped, never a reason to refuse the message.
 */
export function parseIdeaRefBlock(text: string): ParsedIdeaRef[] {
  if (!isIdeaRefBlock(text)) return [];
  const out: ParsedIdeaRef[] = [];
  for (const line of text.split("\n")) {
    const m = REF_LINE_RE.exec(line);
    if (m === null) continue;
    out.push({
      value: m[1],
      text: m[2],
      projectDir: m[3],
      verdict: m[4] as IdeaRefVerdict,
    });
  }
  return out;
}

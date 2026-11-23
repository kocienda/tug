/**
 * arc-ref-block.ts — the trailing block that tells the model what each arc
 * reference in a message actually names.
 *
 * An arc atom reaches the model as `` `@arc:<project>/<name>` ``, and an arc
 * name is unique only inside one checkout's arc log, and only for one
 * generation of it: a name discarded and opened again is two arcs. So the
 * message carries one trailing block that resolves every arc reference in it
 * — the checkout it lives in, the generation the atom pinned, how it ended,
 * and a verdict saying whether it can be read from here.
 *
 * ```text
 * <!-- tug:arc-refs -->
 * Arc references in this message (read one with the command shown; do not guess at what a reference means):
 * - @arc:tug/gpu-wedge — project /Users/k/src/tug, created 2026-11-22T14:59:33.128Z, fate: joined a34061901, verdict: here — read: tugtool arc show gpu-wedge --created 2026-11-22T14:59:33.128Z
 * - @arc:eucit/fold-rail — project /u/src/eucit, fate: live, verdict: elsewhere — read: tugtool arc show fold-rail --project /u/src/eucit
 * - @arc:tug/nope — verdict: absent — no arc of this name is recorded for that project
 * ```
 *
 * The session block's shape, kept rather than reinvented (`session-ref-block.ts`):
 * a fact sheet stripped on the way back in, `null` for a message with no arc
 * atom so that message is byte-identical, every verdict said out loud, and a
 * forgiving line-based parse. Pure, with no imports.
 *
 * @module lib/arc-ref-block
 */

/** The HTML comment that opens the block — the marker every reader keys on. */
export const ARC_REFS_MARKER = "<!-- tug:arc-refs -->";

/** The instruction line, directly under the marker. */
const ARC_REFS_HEADING =
  "Arc references in this message (read one with the command shown; do not guess at what a reference means):";

/** What the client knows about one reference at the moment it is sent. */
export type ArcRefVerdict = "here" | "elsewhere" | "absent" | "unverified";

/** How the arc ended, where the client knows it. */
export type ArcRefFate = "live" | "joined" | "discarded";

/** One reference's row in the block. */
export interface ArcRefEntry {
  /** The atom's value — `<project leaf>/<name>`, the marker's own spelling. */
  value: string;
  verdict: ArcRefVerdict;
  /** The checkout whose arc log holds the arc. */
  projectDir?: string;
  /** The generation's start, where the client knows it. */
  created?: string;
  /** Whether `created` was pinned by the atom, so the read names it. */
  pinned?: boolean;
  fate?: ArcRefFate;
  /** The join commit, for a joined arc. */
  joinSha?: string;
}

/** The identity a parsed line recovers, for a replay to put back on the atom. */
export interface ParsedArcRef {
  value: string;
  projectDir: string;
  created?: string;
  verdict: ArcRefVerdict;
}

/** Whether a text block IS the arc reference block. */
export function isArcRefBlock(text: string): boolean {
  return text.startsWith(ARC_REFS_MARKER);
}

/** The name half of the value — what `tugtool arc show` takes. */
function nameOf(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

/** `live`, `joined <short sha>` or `discarded`. */
function fateWords(entry: ArcRefEntry): string | null {
  if (entry.fate === undefined) return null;
  if (entry.fate === "joined" && entry.joinSha !== undefined && entry.joinSha !== "") {
    return `joined ${entry.joinSha.slice(0, 9)}`;
  }
  return entry.fate;
}

/** The read command, naming the generation and the checkout when they matter. */
function showCommand(entry: ArcRefEntry, withProject: boolean): string {
  let cmd = `tugtool arc show ${nameOf(entry.value)}`;
  if (entry.pinned === true && entry.created !== undefined) {
    cmd += ` --created ${entry.created}`;
  }
  if (withProject && entry.projectDir !== undefined) {
    cmd += ` --project ${entry.projectDir}`;
  }
  return cmd;
}

/**
 * One entry's line. A found arc names the command that reads it; `absent`
 * says so and stops; `unverified` points at the command that settles it.
 */
function refLine(entry: ArcRefEntry): string {
  const head = `- @arc:${entry.value}`;
  if (entry.verdict === "absent") {
    return `${head} — verdict: absent — no arc of this name is recorded for that project`;
  }
  if (entry.verdict === "unverified" || entry.projectDir === undefined) {
    return `${head} — verdict: ${entry.verdict} — check: ${showCommand(entry, true)}`;
  }
  const facts = [`project ${entry.projectDir}`];
  if (entry.created !== undefined) facts.push(`created ${entry.created}`);
  const fate = fateWords(entry);
  if (fate !== null) facts.push(`fate: ${fate}`);
  facts.push(`verdict: ${entry.verdict}`);
  return (
    `${head} — ${facts.join(", ")}`
    + ` — read: ${showCommand(entry, entry.verdict === "elsewhere")}`
  );
}

/**
 * Build the block for a message's arc references, or `null` when there are
 * none, so a message with no arc atom is byte-identical to before.
 */
export function buildArcRefBlock(entries: readonly ArcRefEntry[]): string | null {
  if (entries.length === 0) return null;
  return [ARC_REFS_MARKER, ARC_REFS_HEADING, ...entries.map(refLine)].join("\n");
}

/**
 * A line that carried an identity. The project dir is lazy so it stops at the
 * first optional field or the `, verdict:` that follows: a directory can hold
 * a comma, and those tails cannot.
 */
const REF_LINE_RE =
  /^- @arc:(\S+) — project (.+?)(?:, created (\S+))?(?:, fate: [^,]+)?, verdict: (here|elsewhere|absent|unverified)\b/;

/**
 * Parse the identities out of a block. Line-based and forgiving: a line this
 * reader does not recognise is skipped, never a reason to refuse the message.
 */
export function parseArcRefBlock(text: string): ParsedArcRef[] {
  if (!isArcRefBlock(text)) return [];
  const out: ParsedArcRef[] = [];
  for (const line of text.split("\n")) {
    const m = REF_LINE_RE.exec(line);
    if (m === null) continue;
    out.push({
      value: m[1],
      projectDir: m[2],
      ...(m[3] !== undefined ? { created: m[3] } : {}),
      verdict: m[4] as ArcRefVerdict,
    });
  }
  return out;
}

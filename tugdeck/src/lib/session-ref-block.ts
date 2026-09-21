/**
 * session-ref-block.ts — the trailing block that tells the model what each
 * session reference in a message actually names.
 *
 * A session atom reaches the model as `` `@session:<project>/<callsign>` ``,
 * and that is a NAME. The model cannot look a callsign up: the ledger that
 * mints them is per-instance, the callsign is unique only inside one, and the
 * model has no ledger at all. So the message carries one trailing block that
 * resolves every reference in it — the uuid to read the session by, the
 * directory it ran in, and a verdict saying whether it can be read from here.
 *
 * ```text
 * <!-- tug:session-refs -->
 * Session references in this message (read one with the command shown; do not guess at what a reference means):
 * - @session:eucit/curly-apple — uuid 0f3c…, project /u/src/eucit, verdict: elsewhere — read: tugtool session show 0f3c…
 * - @session:tug/odd-kiln — verdict: absent — this session is not on this machine
 * ```
 *
 * **The block is a fact sheet, not a chip.** It is stripped on the way back
 * in — a replayed message renders the chips the markers carry and never the
 * block's prose — so nothing the user reads is written here. What it costs is
 * a few lines of wire text per message that carries a session atom, and what
 * it buys is a model that can act on the reference rather than guess at it.
 *
 * **The verdict is said out loud, including when there is nothing to say.**
 * `absent` tells the model plainly that the session is not on this machine,
 * which is the one answer a model left to its own devices will invent around;
 * `unverified` says the client has not heard back yet and names the command
 * that settles it. Neither is silence, and that is deliberate.
 *
 * Pure, and imports only a type. The parse half is deliberately forgiving:
 * anything that is not a line it recognises is ignored rather than refused,
 * so a block written by a newer client is read for what this one understands.
 *
 * @module lib/session-ref-block
 */

/** The HTML comment that opens the block — the marker every reader keys on. */
export const SESSION_REFS_MARKER = "<!-- tug:session-refs -->";

/** The instruction line, directly under the marker. */
const SESSION_REFS_HEADING =
  "Session references in this message (read one with the command shown; do not guess at what a reference means):";

/** What the client knows about one reference at the moment it is sent. */
export type SessionRefVerdict = "here" | "elsewhere" | "absent" | "unverified";

/** One reference's row in the block. */
export interface SessionRefEntry {
  /** The atom's value — `<project>/<callsign>`, the marker's own spelling. */
  value: string;
  verdict: SessionRefVerdict;
  /** The full session uuid, where the client knows it. */
  sessionId?: string;
  /** The directory the session ran in, where the client knows it. */
  projectDir?: string;
}

/**
 * The identity a parsed line recovers — everything a replay can put back onto
 * the atom the marker re-minted.
 */
export interface ParsedSessionRef {
  value: string;
  sessionId: string;
  projectDir: string;
  verdict: SessionRefVerdict;
}

/** Whether a text block IS the reference block. */
export function isSessionRefBlock(text: string): boolean {
  return text.startsWith(SESSION_REFS_MARKER);
}

/**
 * One entry's line.
 *
 * A verdict with an identity behind it names the command that reads the
 * session, because a uuid the model cannot act on is trivia. Without one there
 * is no read to offer: `absent` says so and stops, and `unverified` points at
 * the command that answers the question the client could not.
 */
function refLine(entry: SessionRefEntry): string {
  const head = `- @session:${entry.value}`;
  if (entry.verdict === "absent") {
    return `${head} — verdict: absent — this session is not on this machine`;
  }
  if (entry.sessionId === undefined || entry.projectDir === undefined) {
    return `${head} — verdict: ${entry.verdict} — check: tugtool session find ${entry.value}`;
  }
  return (
    `${head} — uuid ${entry.sessionId}, project ${entry.projectDir},`
    + ` verdict: ${entry.verdict} — read: tugtool session show ${entry.sessionId}`
  );
}

/**
 * Build the block for a message's references, or `null` when there are none.
 *
 * `null` rather than an empty block: a message with no session atom must be
 * byte-identical to what it was before this existed, and a marker with no
 * rows under it would be a change to every message that carries none.
 */
export function buildSessionRefBlock(
  entries: readonly SessionRefEntry[],
): string | null {
  if (entries.length === 0) return null;
  return [SESSION_REFS_MARKER, SESSION_REFS_HEADING, ...entries.map(refLine)].join(
    "\n",
  );
}

/**
 * A line that carried an identity — `- @session:<value> — uuid <id>, project
 * <dir>, verdict: <word>`.
 *
 * The project dir is lazy (`.+?`) so it stops at the `, verdict:` that
 * follows rather than swallowing it: a directory can hold a comma, and the
 * verdict tail is the one thing that cannot.
 */
const REF_LINE_RE =
  /^- @session:(\S+) — uuid (\S+), project (.+?), verdict: (here|elsewhere|absent|unverified)\b/;

/**
 * Parse the identities out of a block.
 *
 * Line-based and forgiving on purpose. A line this reader does not recognise
 * — an `absent` row with no uuid, a heading, a form a newer client writes — is
 * skipped rather than failing the parse, because the block's job on the way
 * back in is to restore what it can and never to reject a message.
 */
export function parseSessionRefBlock(text: string): ParsedSessionRef[] {
  if (!isSessionRefBlock(text)) return [];
  const out: ParsedSessionRef[] = [];
  for (const line of text.split("\n")) {
    const m = REF_LINE_RE.exec(line);
    if (m === null) continue;
    out.push({
      value: m[1],
      sessionId: m[2],
      projectDir: m[3],
      verdict: m[4] as SessionRefVerdict,
    });
  }
  return out;
}

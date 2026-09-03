/**
 * arc-note-command.ts — the one reading of an arc-note row's synthetic
 * command, shared by the layers that must agree on it.
 *
 * An arc gesture's quiet line ([P12]) rides the shell ledger as a row whose
 * command is *rendered from the record* by tugcast's `command_for_line`
 * (`arc step <name> done`, `arc create <name>`, `arc mark <name> built`,
 * `arc commit <name>`) — never echoed from an invocation, so the bare verb
 * head is the synthetic tell: a command a user actually typed spells
 * `tugtool arc …`.
 *
 * **Both heads.** The shell ledger is durable and every row written before
 * the word moved carries `arc …` ([F19]); a matcher that claimed only the
 * new head would turn each of those back into an ordinary shell entry — full
 * row, address badge, exit end-state — in a transcript that had rendered it
 * as a quiet line. Nothing writes the retired head any more.
 *
 * Two layers read that tell and must never drift: the command-block registry
 * (`session-arc-note-block.tsx`, which claims the row for quiet rendering)
 * and the transcript absorption pass (`absorbArcNotes` in the
 * code-session-store reducer, which re-seats a restored row inside the turn
 * it narrated). One regex, imported by both.
 */

export const ARC_NOTE_COMMAND = /^(arc|dash) (create|step|mark|commit)\s+\S+/;

/** Whether a shell-ledger command is an arc gesture's synthetic quiet line. */
export function matchesArcNote(command: string): boolean {
  return ARC_NOTE_COMMAND.test(command);
}

/**
 * The line's sentence: the server-derived output (`note_for_line`), or the
 * synthetic command for a row old enough to carry none.
 */
export function arcNoteSentence(message: { command: string; output: string }): string {
  const trimmed = message.output.trim();
  return trimmed !== "" ? trimmed : message.command;
}

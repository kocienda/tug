/**
 * dash-note-command.ts — the one reading of a dash-note row's synthetic
 * command, shared by the layers that must agree on it.
 *
 * A dash gesture's quiet line ([P12]) rides the shell ledger as a row whose
 * command is *rendered from the record* by tugcast's `command_for_line`
 * (`dash step <name> done`, `dash create <name>`, `dash mark <name> built`,
 * `dash commit <name>`) — never echoed from an invocation, so the bare
 * `dash` head is the synthetic tell: a command a user actually typed spells
 * `tugtool arc …`.
 *
 * Two layers read that tell and must never drift: the command-block registry
 * (`session-dash-note-block.tsx`, which claims the row for quiet rendering)
 * and the transcript absorption pass (`absorbDashNotes` in the
 * code-session-store reducer, which re-seats a restored row inside the turn
 * it narrated). One regex, imported by both.
 */

export const ARC_NOTE_COMMAND = /^dash (create|step|mark|commit)\s+\S+/;

/** Whether a shell-ledger command is a dash gesture's synthetic quiet line. */
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

/**
 * The call mark a Bash command may open with, and how the block reads past
 * it.
 *
 * `tugtool hook pre-tool-use` once rewrote every Bash call it could read to
 * open with a `# tug-call: <id>` line, so whatever the call ran read its id
 * back from the shell's argv. It no longer does: the id is kept in a call
 * record beside the command (`tugcore::call_id`, [D233]), because auto mode
 * refuses a call whose input a hook changed. A transcript recorded while the
 * hook marked commands still carries the mark, and it was never the model's
 * own text, so the block elides its own id's mark from the command it shows
 * and copies. A mark naming another id is part of the command and stands.
 *
 * @module lib/call-id-prefix
 */

/** The mark the hook writes, up to the id (`tugcore::call_id::CALL_MARK`). */
export const CALL_MARK = "# tug-call: ";

/** `command` with the hook's mark of `toolUseId` removed, else as given. */
export function stripCallIdPrefix(command: string, toolUseId: string): string {
  const prefix = `${CALL_MARK}${toolUseId}\n`;
  return command.startsWith(prefix) ? command.slice(prefix.length) : command;
}

/**
 * The hook's mark on every readable Bash call, and how the block reads
 * past it.
 *
 * `tugtool hook pre-tool-use` rewrites every Bash call it can read to open
 * with a `# tug-call: <id>` line — a comment the shell ignores and Claude
 * Code's permission check reads past, which rides into the argv of the shell
 * that runs the call, so whatever the call runs — a recipe, a nested `just`,
 * a probe's child — reads its id back and reports to this call's block
 * exactly. The mark is the hook's, not the model's, so the block elides its
 * own id's mark from the command it shows and copies: the header reads what
 * the model wrote. A mark naming another id, or one the model typed itself,
 * is part of the command and stands.
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

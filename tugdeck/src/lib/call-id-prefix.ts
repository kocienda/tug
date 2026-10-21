/**
 * The hook's prefix on every readable Bash call, and how the block reads
 * past it.
 *
 * `tugtool hook pre-tool-use` rewrites every Bash call it can read to open
 * with `export TUG_TOOL_USE_ID=<id>; `, so whatever the call runs — a recipe,
 * a nested `just`, a probe's child — reports to this call's block exactly.
 * The prefix is the hook's, not the model's, so the block elides its own id's
 * export from the command it shows and copies: the header reads what the
 * model wrote. An export naming another id, or one the model typed itself, is
 * part of the command and stands.
 *
 * @module lib/call-id-prefix
 */

/** The export the hook writes, up to the id (`tugcore::report_gaps::CALL_ID_EXPORT`). */
export const CALL_ID_EXPORT = "export TUG_TOOL_USE_ID=";

/** `command` with the hook's export of `toolUseId` removed, else as given. */
export function stripCallIdPrefix(command: string, toolUseId: string): string {
  const prefix = `${CALL_ID_EXPORT}${toolUseId};`;
  if (!command.startsWith(prefix)) return command;
  const rest = command.slice(prefix.length);
  return rest.startsWith(" ") ? rest.slice(1) : rest;
}

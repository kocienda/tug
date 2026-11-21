/**
 * shell-share.ts — compose the fenced text that carries a `$`-route shell
 * exchange into Claude's context ([P08]).
 *
 * Lives in `lib` (not the shell view layer) because two surfaces compose it:
 * the transcript's Share / Add-to-context affordances (a component) and
 * {@link ShellSessionStore}'s VISIBILITY=Context auto-stage (a store). Kept a
 * pure function over a narrow structural input so neither layer has to reach
 * across the other.
 *
 * @module lib/shell-share
 */

import { applyCarriageReturns } from "@/lib/ansi/carriage-return";

/**
 * Character cap on the output portion of a shared exchange ([P08]).
 * Sharing routes the text into a Claude turn's input, so an oversized capture
 * is truncated with a marker; the full output stays in the transcript row.
 */
export const SHELL_SHARE_OUTPUT_CAP = 8_000;

/** Truncation marker appended when a shared output exceeds the cap. */
export const SHELL_SHARE_TRUNCATION_MARKER = "…truncated";

/** The exchange fields the share text is composed from. `ShellExchangeMessage`
 *  structurally satisfies this, so callers pass the message directly. */
export interface ShellShareInput {
  command: string;
  /** Combined stdout+stderr. */
  output: string;
  /** `null` for a killed / timed-out exchange. */
  exitCode: number | null;
  /** `null` while in flight; set when the exchange settles. */
  settledAtMs: number | null;
}

/**
 * Compose the share text for an exchange ([P08]): one fenced block carrying the
 * `$`-prefixed command, the (possibly truncated) output, and the exit line. The
 * fence is lengthened past any backtick run in the content so output containing
 * ``` never breaks the block. Ends with a newline so the user can keep typing
 * after the block.
 */
export function composeShellShareText(
  msg: ShellShareInput,
  outputCap: number = SHELL_SHARE_OUTPUT_CAP,
): string {
  const lines: string[] = [`$ ${msg.command}`];
  // What the block shows, not every value a redrawn line ever held.
  let output = applyCarriageReturns(msg.output).replace(/\n$/, "");
  if (output.length > outputCap) {
    const slice = output.slice(0, outputCap);
    const lastNewline = slice.lastIndexOf("\n");
    output = lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
    output += `\n${SHELL_SHARE_TRUNCATION_MARKER}`;
  }
  if (output.length > 0) lines.push(output);
  const settled = msg.settledAtMs !== null;
  if (settled) {
    lines.push(msg.exitCode === null ? "[killed]" : `[exit ${msg.exitCode}]`);
  }
  const body = lines.join("\n");
  // A fence must be longer than any backtick run inside the block.
  const longestRun = body.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${body}\n${fence}\n`;
}

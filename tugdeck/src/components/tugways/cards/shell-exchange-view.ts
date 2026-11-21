/**
 * Pure view-derivation for a shell exchange row ([P06], Spec S04). Maps a
 * `ShellExchangeMessage` to the `TerminalBlock` data + the header/footer
 * labels the `ShellExchangeBlock` paints. Kept pure so it is unit-tested
 * without a render (the rendered DOM is covered by the app-test).
 */

import { applyCarriageReturns } from "@/lib/ansi/carriage-return";
import type { ShellExchangeMessage } from "@/lib/code-session-store/types";
import type { TerminalData } from "../body-kinds/terminal-block";

// The share-text composer moved to `lib` ([P08]) so the store layer's
// VISIBILITY=Context auto-stage can compose the same fenced block; re-exported
// here for the transcript's Share / Add-to-context affordances and the tests.
export {
  composeShellShareText,
  SHELL_SHARE_OUTPUT_CAP,
  SHELL_SHARE_TRUNCATION_MARKER,
} from "@/lib/shell-share";

export interface ShellExchangeView {
  command: string;
  /**
   * Output-only `TerminalData` for the settled block — no `exitCode` /
   * `durationMs` / `interrupted`, so the embedded `TerminalBlock` draws no
   * in-block footer. The exit + duration are the Z1B's job (the end-state
   * row below the block), matching the assistant turn's grammar.
   */
  terminal: TerminalData;
  /** True until the exchange settles (`settledAtMs === null`). */
  inFlight: boolean;
  /** `exit 0` / `exit 1` / `killed`; `null` while in flight. */
  exitLabel: string | null;
  /** `12ms` / `1.2s`; `null` while in flight. */
  durationLabel: string | null;
  /** `true` for a settled non-zero exit or a kill — drives the danger tone. */
  failed: boolean;
}

export function formatShellDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

export function deriveShellExchangeView(
  msg: ShellExchangeMessage,
): ShellExchangeView {
  const inFlight = msg.settledAtMs === null;
  const durationMs = inFlight
    ? undefined
    : Math.max(0, (msg.settledAtMs ?? msg.startedAtMs) - msg.startedAtMs);
  // A killed exchange settles with a null exit code.
  const killed = !inFlight && msg.exitCode === null;
  return {
    command: msg.command,
    // Output only — the exit code and duration render in the Z1B end-state
    // row, not inside the terminal block (parity with the assistant turn). A
    // carriage return redraws its line, so a progress line shows its latest
    // value, in flight and settled alike.
    terminal: {
      stdout: applyCarriageReturns(msg.output),
      stderr: "",
    },
    inFlight,
    exitLabel: inFlight ? null : killed ? "killed" : `exit ${msg.exitCode}`,
    durationLabel: durationMs === undefined ? null : formatShellDuration(durationMs),
    failed: !inFlight && msg.exitCode !== 0,
  };
}

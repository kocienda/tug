/**
 * `compaction` — pure compaction helpers for the reducer: the transcript
 * divider's text, and recognition of a `/compact` submission.
 *
 * A `compact_boundary` frame (in practice: claude's auto-compaction at
 * capacity) becomes a `system_note` with `source: "compact"` in the
 * active turn. This derives the divider's text from the frame's
 * pre-compaction token count. The divider deliberately mirrors the
 * *terminal's* compaction indicator — a soft separator — not the raw
 * "This session is being continued…" summary block, which Claude Code's
 * own UI (and tugcode's replay translator) hide.
 */

/**
 * Round a token count to a compact `~Nk tokens` / `N tokens` label. Exported
 * because it is the app's one spelling of a token total, and the arc receipt's
 * stage row prints the same figure for a finished stage.
 */
export function formatTokensApprox(tokens: number): string {
  if (tokens >= 1000) return `~${Math.round(tokens / 1000)}k tokens`;
  return `${tokens} tokens`;
}

/**
 * Divider text for a compaction `system_note`. Includes the
 * pre-compaction context size when claude reported it; a bare
 * "Session compacted" otherwise.
 */
export function compactionNoteText(preTokens?: number): string {
  if (typeof preTokens === "number" && preTokens > 0) {
    return `Session compacted · ${formatTokensApprox(preTokens)}`;
  }
  return "Session compacted";
}

/**
 * The editor substrate's atom placeholder (`U+FFFC`). Inlined rather than
 * imported from `tug-atom-img`, which carries theme + DOM dependencies this
 * module (and the reducer that consumes it) must stay free of.
 */
const ATOM_CHAR = "￼";

/** `/compact`, optionally followed by a focus argument. */
const COMPACT_TEXT_RE = /^\/compact(?:\s|$)/;

/**
 * Whether an in-flight user submission is a `/compact` invocation. Pure.
 *
 * Recognizes both shapes the composer produces: a leading command ATOM (the
 * `/compact` chip, which is what the Z2 menu's `compact` action and the
 * composer's own command completion mint), and plain leading `/compact` text
 * with an optional focus argument.
 *
 * Load-bearing for `handleInterrupt` — see the CASE A gate there for why a
 * compaction turn cannot be treated as a turn claude has not started.
 */
export function isCompactionSubmission(
  text: string,
  atoms: ReadonlyArray<{ type: string; value: string }>,
): boolean {
  const lead = atoms[0];
  if (lead !== undefined && lead.type === "command" && text.startsWith(ATOM_CHAR)) {
    return lead.value === "compact";
  }
  return COMPACT_TEXT_RE.test(text);
}

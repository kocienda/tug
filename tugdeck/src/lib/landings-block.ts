/**
 * landings-block.ts — the trailing block that tells the model what the user
 * landed since its last turn.
 *
 * A commit, push, join or discard changes the tree the model is working in,
 * and the model's own record holds nothing at the receipt's position. So
 * tugcast appends one `tug:landings` text block to the next ordinary user
 * message on that line — it owns the shell ledger, the told watermark and
 * the receipt summaries, so the block is composed where the truth is.
 *
 * The deck never writes the block and never reads its content. Its one part
 * is to strip it on replay, on the same terms as `tug:session-refs`, so the
 * user's row renders as they wrote it and the transcript gains nothing.
 *
 * @module lib/landings-block
 */

/**
 * The HTML comment that opens the block — a copy of `LANDINGS_MARKER` in
 * `tugrust/crates/tugcore/src/session_transcript.rs`, which is the source.
 */
export const LANDINGS_MARKER = "<!-- tug:landings -->";

/** Whether a text block is the landings block. */
export function isLandingsBlock(text: string): boolean {
  return text.startsWith(LANDINGS_MARKER);
}

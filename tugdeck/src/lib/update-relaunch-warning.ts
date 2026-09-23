/**
 * update-relaunch-warning.ts — what the wizard's *Stop work in flight* row has
 * to say about the sessions it is offering to end.
 *
 * Sparkle's own relaunch dialog could never say this, and it is the reason
 * the update surface is worth building in the deck rather than natively: the
 * deck knows which sessions have a turn in flight, and a relaunch ends every
 * one of them mid-sentence. Telling the user *which* is the difference
 * between an informed click and a lost turn. `deriveUpdateRows` is the one
 * caller, and it uses the line as the Stop-work row's detail.
 *
 * The fold is here rather than in the component so it can be read without
 * mounting one, and so the wording lives in one place instead of in three
 * branches of JSX.
 *
 * @module lib/update-relaunch-warning
 */

/** How many titles the sentence names before it starts counting instead. */
export const MAX_NAMED_SESSIONS = 3;

/**
 * The sentence the Stop-work row carries, or `null` when nothing is mid-turn —
 * which is also how the row knows it is already done.
 *
 * Silence is the common case and it is deliberate: a warning that appears on
 * every relaunch is a warning nobody reads, so it appears only when there is
 * something real to lose.
 *
 * Past {@link MAX_NAMED_SESSIONS} the sentence stops naming and starts
 * counting — a list of nine titles in one row's detail is a wall, and the
 * thing the user needs to know at that point is that it is *several*, not
 * which.
 * Untitled sessions are counted rather than named for the same reason: "and
 * one more" says more than an empty pair of quotes.
 */
export function relaunchWarningLine(
  titles: readonly string[],
): string | null {
  const named = titles.filter((title) => title.trim() !== "");
  const unnamed = titles.length - named.length;
  if (titles.length === 0) return null;

  if (named.length === 0) {
    return titles.length === 1
      ? "A session is mid-turn and will be interrupted."
      : `${titles.length} sessions are mid-turn and will be interrupted.`;
  }

  if (named.length > MAX_NAMED_SESSIONS || unnamed > 0) {
    return `${titles.length} sessions are mid-turn and will be interrupted.`;
  }

  return `${joinTitles(named)} ${named.length === 1 ? "is" : "are"} mid-turn and will be interrupted.`;
}

/** `a`, `a and b`, `a, b and c` — the house serial form, without the comma. */
function joinTitles(titles: readonly string[]): string {
  if (titles.length === 1) return titles[0];
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}
